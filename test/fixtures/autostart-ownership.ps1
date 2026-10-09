param([string]$Case, [string]$ScriptPath)
$ErrorActionPreference = 'Stop'
$global:FixtureRegistered = 0
$global:FixtureRemoved = 0
$vbs = Join-Path (Split-Path -Parent $ScriptPath) 'autostart.vbs'
$global:FixtureTask = $null
if ($Case -like 'owned-*') {
    $global:FixtureTask = [pscustomobject]@{ Actions = @([pscustomobject]@{ Execute='wscript.exe'; Arguments=('"{0}"' -f $vbs) }) }
} elseif ($Case -like 'foreign-*') {
    $global:FixtureTask = [pscustomobject]@{ Actions = @([pscustomobject]@{ Execute='wscript.exe'; Arguments='"Z:\synthetic-other-checkout\autostart.vbs"' }) }
}
function global:Get-ScheduledTask { param($TaskName,$TaskPath,$ErrorAction) if ($Case -eq 'lookup-error') { throw 'Synthetic task lookup failure' }; return $global:FixtureTask }
function global:Unregister-ScheduledTask { param($TaskName,$TaskPath,$Confirm,$ErrorAction) $global:FixtureRemoved++ }
function global:Register-ScheduledTask { param($TaskName,$TaskPath,$Action,$Trigger,$Settings,$Description,[switch]$Force) $global:FixtureRegistered++ }
function global:New-ScheduledTaskAction { param($Execute,$Argument) return [pscustomobject]@{Execute=$Execute;Arguments=$Argument} }
function global:New-ScheduledTaskTrigger { param([switch]$AtLogOn,$User) return [pscustomobject]@{Fixture='trigger'} }
function global:New-ScheduledTaskSettingsSet { param([switch]$StartWhenAvailable,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries,$ExecutionTimeLimit) return [pscustomobject]@{Fixture='settings'} }
$failed = $false
try {
    if ($Case -like '*-remove') { & $ScriptPath -Remove | Out-Null }
    else { & $ScriptPath | Out-Null }
} catch { $failed = $true }
[ordered]@{failed=$failed;registered=$global:FixtureRegistered;removed=$global:FixtureRemoved} | ConvertTo-Json -Compress
