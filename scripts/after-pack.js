'use strict';

const { execFileSync, spawnSync } = require('child_process');
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

// Python 3 disposant du client castlabs EVS (pip install castlabs-evs).
function findEvsPython() {
  const candidates = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
  for (const [cmd, args] of candidates) {
    const r = spawnSync(cmd, [...args, '-c', 'import castlabs_evs'], { stdio: 'ignore' });
    if (r.status === 0) return [cmd, args];
  }
  return null;
}

// Signature VMP de production (Widevine) : sans elle, Prime Video, Netflix ou
// Disney+ peuvent refuser la licence du contenu dans l'application installée.
// Elle doit être faite APRÈS toute modification de l'exécutable (rcedit).
// Compte EVS gratuit requis : voir README. ZAALIS_REQUIRE_VMP=1 rend la
// signature obligatoire (build de publication).
function vmpSign(appOutDir) {
  const python = findEvsPython();
  if (!python) {
    const msg = 'castlabs-evs est introuvable : installeur généré SANS signature VMP de production ' +
                '(pip install castlabs-evs, puis python -m castlabs_evs.account signup).';
    if (process.env.ZAALIS_REQUIRE_VMP === '1') throw new Error(msg);
    console.warn('  • ' + msg);
    return;
  }
  const [cmd, args] = python;
  try {
    execFileSync(cmd, [...args, '-m', 'castlabs_evs.vmp', 'sign-pkg', appOutDir], {
      stdio: 'inherit',
      env: { ...process.env, EVS_NO_ASK: process.env.EVS_NO_ASK || '1' },
    });
  } catch (e) {
    const msg = 'signature VMP impossible (compte EVS non connecté ?) : ' + e.message;
    if (process.env.ZAALIS_REQUIRE_VMP === '1') throw new Error(msg);
    console.warn('  • ' + msg);
  }
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

  // Signature de développement d'electron.exe : inutile une fois renommé.
  try { fs.unlinkSync(path.join(context.appOutDir, 'electron.exe.sig')); } catch {}
  vmpSign(context.appOutDir);
};
