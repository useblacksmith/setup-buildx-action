import * as core from '@actions/core';

export const IsDebug = !!process.env['STATE_isDebug'];
export const standalone = /true/i.test(process.env['STATE_standalone'] || '');
export const builderName = process.env['STATE_builderName'] || '';
export const builderDriver = process.env['STATE_builderDriver'] || '';
export const containerName = process.env['STATE_containerName'] || '';
export const certsDir = process.env['STATE_certsDir'] || '';
export const cleanup = /true/i.test(process.env['STATE_cleanup'] || '');
export const isStickyDisksEnabled = !!process.env['STATE_isStickyDisksEnabled'];
export const blacksmithBuildTaskId = process.env['STATE_blacksmithBuildTaskId'] || '';
export const blacksmithClientKey = process.env['STATE_blacksmithClientKey'] || '';
export const blacksmithClientCaCertificate = process.env['STATE_blacksmithClientCaCertificate'] || '';
export const blacksmithRootCaCertificate = process.env['STATE_blacksmithRootCaCertificate'] || '';

export function setDebug(debug: string) {
  core.saveState('isDebug', debug);
}

export function setStandalone(standalone: boolean) {
  core.saveState('standalone', standalone);
}

export function setBuilderName(builderName: string) {
  core.saveState('builderName', builderName);
}

export function setBuilderDriver(builderDriver: string) {
  core.saveState('builderDriver', builderDriver);
}

export function setContainerName(containerName: string) {
  core.saveState('containerName', containerName);
}

export function setCertsDir(certsDir: string) {
  core.saveState('certsDir', certsDir);
}

export function setCleanup(cleanup: boolean) {
  core.saveState('cleanup', cleanup);
}

export function setStickyDisksEnabled(isStickyDisksEnabled: string) {
  core.saveState('isStickyDisksEnabled', isStickyDisksEnabled);
}

export function setBlacksmithBuildTaskId(blacksmithBuildTaskId: string) {
  core.saveState('blacksmithBuildTaskId', blacksmithBuildTaskId);
}

export function setBlacksmithClientKey(blacksmithClientKey: string) {
  core.saveState('blacksmithClientKey', blacksmithClientKey);
}

export function setBlacksmithClientCaCertificate(blacksmithClientCaCertificate: string) {
  core.saveState('blacksmithClientCaCertificate', blacksmithClientCaCertificate);
}

export function setBlacksmithRootCaCertificate(blacksmithRootCaCertificate: string) {
  core.saveState('blacksmithRootCaCertificate', blacksmithRootCaCertificate);
}
