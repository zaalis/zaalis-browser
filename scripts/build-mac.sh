#!/usr/bin/env bash
# Construit zaalis Browser pour macOS : produit deux .dmg (arm64 + x64) dans dist/.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo "==> npm install"
  npm install
fi

echo "==> génération de l'icône"
node scripts/make-icns.js

echo "==> build DMG arm64 + x64"
npx electron-builder --mac dmg --arm64 --x64 --config electron-builder.json

echo
echo "==> fichiers produits :"
ls -la dist/*.dmg 2>/dev/null || echo "aucun .dmg trouvé"
