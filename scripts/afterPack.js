// Signature ad-hoc + retrait quarantine après empaquetage.
// Sans ça, macOS refuse de lancer une app locale non signée (Gatekeeper).
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  try {
    execFileSync('/usr/bin/codesign', ['--deep', '--force', '--sign', '-', appPath], { stdio: 'inherit' });
  } catch (e) { console.error('codesign ad-hoc a échoué :', e.message); }
  try {
    execFileSync('/usr/bin/xattr', ['-cr', appPath], { stdio: 'inherit' });
  } catch {}
};
