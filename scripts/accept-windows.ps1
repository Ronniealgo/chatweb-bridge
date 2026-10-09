# Run in a fresh exported directory. Never starts services, browser, DSH or tasks.
param([switch]$Install, [switch]$Offline, [string]$CacheDirectory='')
$ErrorActionPreference='Stop'
if (!$IsWindows) { throw 'Windows acceptance requires PowerShell 7 on Windows.' }
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
foreach($command in @('node','npm.cmd','git')) { $null=Get-Command $command -ErrorAction Stop }
& node (Join-Path $root 'scripts/verify-source.mjs')
if($LASTEXITCODE -ne 0){throw 'Source verification failed'}
& node (Join-Path $root 'scripts/verify-license.mjs')
if($LASTEXITCODE -ne 0){throw 'Original license/metadata verification failed'}
if($Install){
 $args=@{};if($Offline){$args.Offline=$true};if($CacheDirectory){$args.CacheDirectory=$CacheDirectory}
 & (Join-Path $root 'install.ps1') @args
 if($LASTEXITCODE -ne 0){throw 'Installation failed'}
}
& node (Join-Path $root 'scripts/patch-runtime.mjs') --verify
if($LASTEXITCODE -ne 0){throw 'Runtime verification failed'}
& node (Join-Path $root 'scripts/test-offline.mjs')
if($LASTEXITCODE -ne 0){throw 'Offline regression failed'}
& node (Join-Path $root 'scripts/verify-source.mjs')
if($LASTEXITCODE -ne 0){throw 'Source changed during installation or regression'}
[ordered]@{result='passed';os=[Environment]::OSVersion.VersionString;node=(& node --version);powerShell=$PSVersionTable.PSVersion.ToString();installationRequested=[bool]$Install;cacheOnly=[bool]$Offline;originalLicenseVerified=$true;upstreamRedistributionCleared=$false;newWindowsAccountVerified=$false;liveDshVerified=$false;servicesStarted=$false}|ConvertTo-Json
