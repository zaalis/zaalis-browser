'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function findResourceEditor() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const cacheRoot = path.join(localAppData, 'electron-builder', 'Cache', 'winCodeSign');
  if (!fs.existsSync(cacheRoot)) return null;

  return fs.readdirSync(cacheRoot)
    .map(name => path.join(cacheRoot, name, 'rcedit-x64.exe'))
    .find(fs.existsSync) || null;
}

exports.default = async context => {
  if (context.electronPlatformName !== 'win32') return;

  const rcedit = findResourceEditor();
  if (!rcedit) {
    throw new Error('rcedit-x64.exe est introuvable dans le cache electron-builder.');
  }

  const executable = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const icon = path.join(context.packager.projectDir, 'assets', 'zaalis.ico');
  execFileSync(rcedit, [executable, '--set-icon', icon], { stdio: 'inherit' });
};
