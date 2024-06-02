import * as fs from 'fs';
import * as core from '@actions/core';
import * as actionsToolkit from '@docker/actions-toolkit';
import { Buildx } from '@docker/actions-toolkit/lib/buildx/buildx';
import { Builder } from '@docker/actions-toolkit/lib/buildx/builder';
import { Docker } from '@docker/actions-toolkit/lib/docker/docker';
import { Exec } from '@docker/actions-toolkit/lib/exec';
import { Toolkit } from '@docker/actions-toolkit/lib/toolkit';
import { Util } from '@docker/actions-toolkit/lib/util';
import { promisify } from 'util';
import { exec } from 'child_process';
import portfinder from 'portfinder';
import * as TOML from '@iarna/toml';
import axios from 'axios';


import * as context from './context';
import * as stateHelper from './state-helper';
import { get } from 'http';

const supportedDockerDriver = 'remote';
const mountPoint = '/var/lib/buildkit';
const device = '/dev/vdb';
const mmdsIPv4Addr = "169.254.169.254";


const execAsync = promisify(exec);

function getEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not set.`);
  }
  return value;
}

function sendLoadStickyDisksRequest() {
  try {
    const port = getEnvVar('VSOCK_PORT');
    const command = `echo "load" | socat -t=15 - VSOCK-CONNECT:2:${port}`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        core.error(`Error executing command: ${error.message}`);
        return;
      }
      if (stderr) {
        core.error(`stderr: ${stderr}`);
        return;
      }
      core.debug(`stdout: ${stdout}`);
    });
  } catch (error) {
    throw error;
  }
}

async function getMetadata(endpoint: string): Promise<string> {
  try {
    const putTokenResponse = await axios.put(`http://${mmdsIPv4Addr}/latest/api/token`, null, {
      headers: {
        "X-metadata-token-ttl-seconds": "21600"
      }
    });
    const token = putTokenResponse.data;
    const getResponse = await axios.get(`http://${mmdsIPv4Addr}/${endpoint}`, {
      headers: {
        "X-metadata-token": token
      }
    });
    const responseData = typeof getResponse.data === 'string' ? getResponse.data : JSON.stringify(getResponse.data);
    return responseData;
  } catch (error) {
    core.debug(`error fetching metadata: ${error}`);
    throw error;
  }
}

async function retryCommand(sleepTime: number, command: () => Promise<string>): Promise<string> {
  let retryAttempts = 0;
  while (true) {
    if (retryAttempts > 10) {
      throw new Error('Maximum number of retries exceeded');
    }
    try {
      const result = await command();
      if (result && !result.includes("Resource not found")) {
        core.debug(`Command result: ${result}`);
        return result;
      }
    } catch (error) {
      core.debug(`Command failed: ${error}`);
    }
    await new Promise(resolve => setTimeout(resolve, sleepTime * 1000));
    retryAttempts++;
  }
}

async function checkBlockDevice(device: string): Promise<boolean> {
  try {
    await execAsync(`lsblk ${device}`);
    return true;
  } catch (error) {
    return false;
  }
}

// Function to gracefully shut down the buildkitd process
async function shutdownBuildkitd(): Promise<void> {
  try {
    await execAsync(`sudo pkill -TERM buildkitd`);
  } catch (error) {
    core.error('error shutting down buildkitd process:', error);
    throw error;
  }
}

async function installBuildkitd() {
  try {
    let downloadUrl = '';
    let tarFile = '';

    downloadUrl = 'https://github.com/moby/buildkit/releases/download/v0.13.2/buildkit-v0.13.2.linux-amd64.tar.gz';
    tarFile = 'buildkit-v0.13.2.linux-amd64.tar.gz';

    await execAsync(`sudo wget ${downloadUrl}`);
    await execAsync(`sudo tar -xvf ${tarFile}`);
    await execAsync(`sudo mv bin/* /usr/local/bin/`);

    core.debug('buildKit installed successfully');
  } catch (error) {
    core.error('error installing BuildKit:', error);
    throw error;
  }
}

async function getDiskSize(device: string): Promise<number> {
  try {
    const { stdout } = await execAsync(`sudo lsblk -b -n -o SIZE ${device}`);
    const sizeInBytes = parseInt(stdout.trim(), 10);
    if (isNaN(sizeInBytes)) {
      throw new Error('Failed to parse disk size');
    }
    return sizeInBytes;
  } catch (error) {
    console.error(`Error getting disk size: ${error.message}`);
    throw error;
  }
}

async function writeBuildkitdTomlFile(): Promise<void> {
  const diskSize = await getDiskSize(device);
  core.info(`disk size is ${diskSize}`);
  const jsonConfig: TOML.JsonMap = {
    worker: {
      oci: {
        enabled: true,
        gc: true,
        gckeepstorage: diskSize,
        gcpolicy: [
          {
            keepBytes: diskSize,
            keepDuration: 172800,
          },
          {
            all: true,
            keepBytes: diskSize
          }
        ]
      }
    }
  };

  const tomlString = TOML.stringify(jsonConfig);

  try {
    await execAsync(`sudo touch buildkitd.toml`);
    await execAsync(`sudo chmod 666 buildkitd.toml`);
    await execAsync(`echo "${tomlString}" > buildkitd.toml`);
    core.debug(`TOML configuration is ${tomlString}`);
  } catch (err) {
    core.warning('error writing TOML configuration:', err);
    throw err;
  }
}


async function startBuildkitd(port: number): Promise<string> {
  try {
    await writeBuildkitdTomlFile();
    const addr = `tcp://0.0.0.0:${port}`;
    const { stdout: startStdout, stderr: startStderr } = await execAsync(
      `sudo nohup buildkitd --addr ${addr} --allow-insecure-entitlement security.insecure --config=buildkitd.toml --allow-insecure-entitlement network.host > buildkitd.log 2>&1 &`,
    );

    if (startStderr) {
      throw new Error(`error starting buildkitd service: ${startStderr}`);
    }
    core.debug(`buildkitd daemon started successfully ${startStdout}`);

    const { stdout, stderr } = await execAsync(`pgrep -f buildkitd`);
    if (stderr) {
      throw new Error(`error finding buildkitd PID: ${stderr}`);
    }
    return addr;
  } catch (error) {
    core.error('failed to start buildkitd daemon:', error);
    throw error;
  }
}

async function findPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    portfinder.getPort({
      port: 49152,
      stopPort: 65535
    }, (error, port) => {
      if (error) {
        console.error(`error finding port: ${error.message}`);
        reject(error);
      }
      resolve(port);
    });
  });
}


actionsToolkit.run(
  // main
  async () => {
    let isStickyDisksEnabled = false;
    const sleepTime = 1; // seconds of retries
    try {
      sendLoadStickyDisksRequest();
      const stickyDiskIsLoaded = await retryCommand(sleepTime, () => getMetadata('sticky_disk_loaded'));
      if (stickyDiskIsLoaded == "true") {
        isStickyDisksEnabled = true;
      }
    } catch (error) {
      core.warning(`error fetching sticky disks metadata: ${error}`);
      // Carry on regardless of sticky disks error.
    }
    try {
      let blockDeviceIsPresent = await checkBlockDevice(device);
      if (isStickyDisksEnabled && blockDeviceIsPresent) {
        stateHelper.setStickyDisksEnabled('true');
        await execAsync(`sudo mkdir -p ${mountPoint}`);
        await execAsync(`sudo mount ${device} ${mountPoint}`);
        core.debug(`${device} has been mounted to ${mountPoint}`);
      }
    } catch (error) {
      core.warning('error setting up sticky disks:', error.message);
      // Carry on regardless of sticky disks error.
    }
    // Start the buildkitd daemon.
    var port = await findPort();
    await installBuildkitd();
    core.debug('starting buildkitd daemon');
    var buildkitdAddr = await startBuildkitd(port);
    core.debug(`buildkitd daemon started at addr ${buildkitdAddr}`);

    const inputs: context.Inputs = await context.getInputs();
    // Override inputs.driver to the only supported driver.
    inputs.endpoint = buildkitdAddr;
    inputs.driver = supportedDockerDriver;
    stateHelper.setCleanup(inputs.cleanup);

    const toolkit = new Toolkit();
    const standalone = await toolkit.buildx.isStandalone();
    stateHelper.setStandalone(standalone);

    await core.group(`Docker info`, async () => {
      try {
        await Docker.printVersion();
        await Docker.printInfo();
      } catch (e) {
        core.info(e.message);
      }
    });

    let toolPath;
    if (Util.isValidRef(inputs.version)) {
      if (standalone) {
        throw new Error(`Cannot build from source without the Docker CLI`);
      }
      await core.group(`Build buildx from source`, async () => {
        toolPath = await toolkit.buildxInstall.build(inputs.version, !inputs.cacheBinary);
      });
    } else if (!(await toolkit.buildx.isAvailable()) || inputs.version) {
      await core.group(`Download buildx from GitHub Releases`, async () => {
        toolPath = await toolkit.buildxInstall.download(inputs.version || 'latest', !inputs.cacheBinary);
      });
    }
    if (toolPath) {
      await core.group(`Install buildx`, async () => {
        if (standalone) {
          await toolkit.buildxInstall.installStandalone(toolPath);
        } else {
          await toolkit.buildxInstall.installPlugin(toolPath);
        }
      });
    }

    await core.group(`Buildx version`, async () => {
      await toolkit.buildx.printVersion();
    });

    core.setOutput('name', inputs.name);
    stateHelper.setBuilderName(inputs.name);
    stateHelper.setBuilderDriver(inputs.driver);

    fs.mkdirSync(Buildx.certsDir, { recursive: true });
    stateHelper.setCertsDir(Buildx.certsDir);

    if (inputs.driver !== 'docker') {
      await core.group(`Creating a new builder instance`, async () => {
        const createCmd = await toolkit.buildx.getCommand(await context.getCreateArgs(inputs, toolkit));
        core.info(`Creating builder with command: ${createCmd.command}`);
        await Exec.getExecOutput(createCmd.command, createCmd.args, {
          ignoreReturnCode: true
        }).then(res => {
          if (res.stderr.length > 0 && res.exitCode != 0) {
            throw new Error(res.stderr.match(/(.*)\s*$/)?.[0]?.trim() ?? 'unknown error');
          }
        });
      });
    }

    await core.group(`Booting builder`, async () => {
      const inspectCmd = await toolkit.buildx.getCommand(await context.getInspectArgs(inputs, toolkit));
      await Exec.getExecOutput(inspectCmd.command, inspectCmd.args, {
        ignoreReturnCode: true
      }).then(res => {
        if (res.stderr.length > 0 && res.exitCode != 0) {
          throw new Error(res.stderr.match(/(.*)\s*$/)?.[0]?.trim() ?? 'unknown error');
        }
      });
    });

    if (inputs.install) {
      if (standalone) {
        throw new Error(`Cannot set buildx as default builder without the Docker CLI`);
      }
      await core.group(`Setting buildx as default builder`, async () => {
        const installCmd = await toolkit.buildx.getCommand(['install']);
        await Exec.getExecOutput(installCmd.command, installCmd.args, {
          ignoreReturnCode: true
        }).then(res => {
          if (res.stderr.length > 0 && res.exitCode != 0) {
            throw new Error(res.stderr.match(/(.*)\s*$/)?.[0]?.trim() ?? 'unknown error');
          }
        });
      });
    }

    const builderInspect = await toolkit.builder.inspect(inputs.name);
    const firstNode = builderInspect.nodes[0];
    const containerName = `${Buildx.containerNamePrefix}${firstNode.name}`;

    await core.group(`Inspect builder`, async () => {
      const reducedPlatforms: Array<string> = [];
      for (const node of builderInspect.nodes) {
        for (const platform of node.platforms?.split(',') || []) {
          if (reducedPlatforms.indexOf(platform) > -1) {
            continue;
          }
          reducedPlatforms.push(platform);
        }
      }
      core.info(JSON.stringify(builderInspect, undefined, 2));
      core.setOutput('driver', builderInspect.driver);
      core.setOutput('platforms', reducedPlatforms.join(','));
      core.setOutput('nodes', JSON.stringify(builderInspect.nodes, undefined, 2));
      core.setOutput('endpoint', firstNode.endpoint); // TODO: deprecated, to be removed in a later version
      core.setOutput('status', firstNode.status); // TODO: deprecated, to be removed in a later version
      core.setOutput('flags', firstNode['buildkitd-flags']); // TODO: deprecated, to be removed in a later version
    });

    if (!standalone && builderInspect.driver == 'docker-container') {
      stateHelper.setContainerName(`${containerName}`);
      await core.group(`BuildKit version`, async () => {
        for (const node of builderInspect.nodes) {
          const buildkitVersion = await toolkit.buildkit.getVersion(node);
          core.info(`${node.name}: ${buildkitVersion}`);
        }
      });
    }
    if (core.isDebug() || firstNode['buildkitd-flags']?.includes('--debug')) {
      stateHelper.setDebug('true');
    }
  },
  // post
  async () => {
    if (stateHelper.IsDebug && stateHelper.containerName.length > 0) {
      await core.group(`BuildKit container logs`, async () => {
        await Exec.getExecOutput('docker', ['logs', `${stateHelper.containerName}`], {
          ignoreReturnCode: true
        }).then(res => {
          if (res.stderr.length > 0 && res.exitCode != 0) {
            core.warning(res.stderr.match(/(.*)\s*$/)?.[0]?.trim() ?? 'unknown error');
          }
        });
      });
    }

    if (!stateHelper.cleanup) {
      return;
    }

    if (stateHelper.builderDriver != 'docker' && stateHelper.builderName.length > 0) {
      await core.group(`Removing builder`, async () => {
        const buildx = new Buildx({ standalone: stateHelper.standalone });
        const builder = new Builder({ buildx: buildx });
        if (await builder.exists(stateHelper.builderName)) {
          const stopCmd = await buildx.getCommand(['stop', stateHelper.builderName]);
          core.debug(`Stopping builder with command: ${stopCmd.command}`);
          await Exec.getExecOutput(stopCmd.command, stopCmd.args, {
            ignoreReturnCode: true
          })

          // If sticky disks are enabled, unmount the mount point.
          try {
            if (stateHelper.isStickyDisksEnabled) {
              await shutdownBuildkitd();
              await execAsync(`sudo umount ${mountPoint}`);
              core.debug(`${device} has been unmounted`);
              // Write /stickydisk/commit.txt to the filesystem to signal that the sticky disks are mounted.
              var stickyDiskCommitFile = "/stickydisk/commit.txt";
              await execAsync(`sudo mkdir -p /stickydisk`);
              await execAsync(`sudo touch ${stickyDiskCommitFile}`);
            }
          } catch (error) {
            core.error('error cleaning up sticky disks:', error);
          }

          const rmCmd = await buildx.getCommand(['rm', stateHelper.builderName]);
          await Exec.getExecOutput(rmCmd.command, rmCmd.args, {
            ignoreReturnCode: true
          }).then(res => {
            if (res.stderr.length > 0 && res.exitCode != 0) {
              core.warning(res.stderr.match(/(.*)\s*$/)?.[0]?.trim() ?? 'unknown error');
            }
          });
        } else {
          core.info(`${stateHelper.builderName} does not exist`);
        }
      });
    }

    if (stateHelper.certsDir.length > 0 && fs.existsSync(stateHelper.certsDir)) {
      await core.group(`Cleaning up certificates`, async () => {
        fs.rmSync(stateHelper.certsDir, { recursive: true });
      });
    }
  }
);
