#!/usr/bin/env bash
# Double-clique ce fichier pour installer zaalis browser dans /Applications.
# Contourne Gatekeeper pour une app locale non-notarisée.

set -e
cd "$(dirname "$0")"

ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  SRC="dist/mac-arm64/zaalis browser.app"
else
  SRC="dist/mac/zaalis browser.app"
fi

if [ ! -d "$SRC" ]; then
  echo "==> Bundle introuvable : $SRC"
  echo "==> Lancement du build. Cela peut prendre quelques minutes..."
  npx electron-builder --mac dmg --config electron-builder.json
fi

DEST="/Applications/zaalis browser.app"

echo "==> Fermeture d'une éventuelle instance en cours"
pkill -9 -f "zaalis browser" 2>/dev/null || true

echo "==> Copie de $SRC vers $DEST"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"

echo "==> Retrait de com.apple.quarantine"
xattr -cr "$DEST"

echo "==> Re-signature ad-hoc"
codesign --deep --force --sign - "$DEST" 2>&1 | tail -3

echo "==> Création d'un alias sur le Bureau"
osascript -e 'tell application "Finder" to make alias file to (POSIX file "/Applications/zaalis browser.app") at (POSIX file "'"$HOME/Desktop"'")' 2>/dev/null || true

echo "==> Lancement"
open "$DEST"

echo
echo "OK  zaalis browser installé et lancé."
