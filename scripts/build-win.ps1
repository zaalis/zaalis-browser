$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Test-Path node_modules)) {
  npm install
}

if (Test-Path dist) {
  Remove-Item -LiteralPath dist -Recurse -Force
}

npm test
npm run selftest
npm run pack:win
