# Installs (or removes) a per-user logon task that starts the bridge hidden.
#   .\install-autostart.ps1            install
#   .\install-autostart.ps1 -Remove    uninstall
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$taskName = 'ChatGPT-Chat-Tool-Bridge'
$vbs = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'autostart.vbs'))
$expectedArguments = '"{0}"' -f $vbs
$existing = $null
try { $existing = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop }
catch {
    if ($_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ObjectNotFound) { throw }
}
if ($existing) {
    $actions = @($existing.Actions)
    $owned = $actions.Count -eq 1 -and
        [System.IO.Path]::GetFileName($actions[0].Execute) -ieq 'wscript.exe' -and
        [string]::Equals($actions[0].Arguments, $expectedArguments, [StringComparison]::OrdinalIgnoreCase)
    if (!$owned) { throw 'The logon task belongs to another checkout or has an unrecognized action; nothing changed.' }
}
if ($Remove) {
    if ($existing) { Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false -ErrorAction Stop }
    Write-Output "Removed $taskName"
    return
}
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $expectedArguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -Trigger $trigger -Settings $settings -Description 'Starts the ChatGPT chat tool bridge for DeepSeek Harness (hidden).' -Force | Out-Null
Write-Output "Installed $taskName (runs at logon, hidden). Remove with: .\install-autostart.ps1 -Remove"
