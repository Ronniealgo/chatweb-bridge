$ErrorActionPreference = 'Stop'
& (Get-Command node -ErrorAction Stop).Source (Join-Path $PSScriptRoot 'scripts/test-offline.mjs')
exit $LASTEXITCODE
