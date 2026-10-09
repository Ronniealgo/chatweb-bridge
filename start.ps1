$ErrorActionPreference = 'Stop'
& (Get-Command node -ErrorAction Stop).Source (Join-Path $PSScriptRoot 'manage.mjs') start
exit $LASTEXITCODE
