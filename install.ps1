# Fresh checkout only: dependency download + verified patch, never service startup/login.
param([switch]$Offline, [string]$CacheDirectory = '')
$ErrorActionPreference = 'Stop'
$installRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
foreach ($name in @('node_modules', 'runtime/node_modules', '.runtime', '.build', 'runtime/.build')) {
    if (Test-Path -LiteralPath (Join-Path $installRoot $name)) {
        throw 'Install only in a fresh checkout. Existing dependency or runtime state is preserved.'
    }
}
# Reject reparse points before npm can follow a dependency directory or manifest elsewhere.
$installRuntime = Get-Item -LiteralPath (Join-Path $installRoot 'runtime') -Force
if (!$installRuntime.PSIsContainer -or ($installRuntime.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'Runtime must be an ordinary directory inside this checkout.'
}
foreach ($name in @('package.json', 'package-lock.json', 'runtime/package.json', 'runtime/package-lock.json')) {
    $installFile = Get-Item -LiteralPath (Join-Path $installRoot $name) -Force
    if ($installFile.PSIsContainer -or ($installFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw 'Dependency manifests must be ordinary files inside this checkout.'
    }
}
foreach ($name in @('.npmrc', 'runtime/.npmrc', 'npm-shrinkwrap.json', 'runtime/npm-shrinkwrap.json')) {
    if (Test-Path -LiteralPath (Join-Path $installRoot $name)) {
        throw 'Unexpected local npm configuration or shrinkwrap; use an exported fresh source checkout.'
    }
}
$installNode = (Get-Command node -ErrorAction Stop).Source
$installNpm = (Get-Command npm.cmd -ErrorAction Stop).Source
$null = Get-Command git -ErrorAction Stop
& $installNode -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<15)){console.error("Node >=22.15 required");process.exit(1)}'
if ($LASTEXITCODE -ne 0) { throw 'Unsupported Node version.' }
$installScratch = Join-Path $installRoot '.build'
New-Item -ItemType Directory -Path $installScratch -Force | Out-Null
$installUserConfig = Join-Path $installScratch 'empty-user.npmrc'
$installGlobalConfig = Join-Path $installScratch 'empty-global.npmrc'
Set-Content -LiteralPath $installUserConfig -Value '' -Encoding ASCII
Set-Content -LiteralPath $installGlobalConfig -Value '' -Encoding ASCII
if (!$CacheDirectory) { $CacheDirectory = Join-Path $installScratch 'npm-cache' }
$installCache = [System.IO.Path]::GetFullPath($CacheDirectory)
$installArguments = @('ci','--ignore-scripts','--no-audit','--no-fund','--update-notifier=false','--registry=https://registry.npmjs.org',"--userconfig=$installUserConfig","--globalconfig=$installGlobalConfig","--cache=$installCache")
if ($Offline) { $installArguments += '--offline' }
foreach ($directory in @($installRoot, (Join-Path $installRoot 'runtime'))) {
    Push-Location $directory
    try {
        & $installNpm @installArguments
        if ($LASTEXITCODE -ne 0) { throw 'Locked dependency installation failed; no service was started.' }
    } finally { Pop-Location }
}
& $installNode (Join-Path $installRoot 'scripts/patch-runtime.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Adapter reconstruction failed; do not start services.' }
Write-Output 'Dependencies installed and all adapter output hashes verified. Services were not started.'
