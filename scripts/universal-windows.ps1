# Per-user Task Scheduler manager. Dot-sourcing defines helpers only.
[CmdletBinding()]
param(
    [ValidateSet('Install', 'Start', 'Stop', 'Status', 'Uninstall')][string]$Action = 'Status',
    [string]$ConfigPath,
    [string]$NodePath,
    [string]$TaskName = 'chatweb-bridge',
    [string]$DesktopShortcutName = 'Chatweb Bridge',
    [ValidateRange(45, 300)][int]$StartupTimeoutSeconds = 60
)
. (Join-Path $PSScriptRoot 'universal-supervisor.ps1') -ConfigPath $ConfigPath -NodePath $NodePath -TaskName $TaskName

function Get-ChatwebTaskDescriptor($Context) {
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ' +
        (ConvertTo-ChatwebArgument $Context.SupervisorPath) + ' -ConfigPath ' + (ConvertTo-ChatwebArgument $Context.ConfigPath) +
        ' -NodePath ' + (ConvertTo-ChatwebArgument $Context.NodePath) + ' -TaskName ' + (ConvertTo-ChatwebArgument $Context.TaskName)
    [pscustomobject]@{
        Execute=$Context.PowerShellPath; Arguments=$arguments
        Description=('chatweb-bridge/windows-v1 config=' + $Context.ConfigId + ' script=' + (Get-ChatwebHash $Context.SupervisorPath.ToLowerInvariant()))
    }
}

function Get-ChatwebOwnedTask($Context) {
    $task = $null
    try { $task = Get-ScheduledTask -TaskName $Context.TaskName -TaskPath '\' -ErrorAction Stop }
    catch {
        if ($_.CategoryInfo.Category -ne [Management.Automation.ErrorCategory]::ObjectNotFound) { throw 'task_lookup_failed' }
    }
    if (!$task) { return $null }
    $expected = Get-ChatwebTaskDescriptor $Context
    $actions = @($task.Actions)
    if ($actions.Count -ne 1 -or
        ![string]::Equals($actions[0].Execute, $expected.Execute, [StringComparison]::OrdinalIgnoreCase) -or
        ![string]::Equals($actions[0].Arguments, $expected.Arguments, [StringComparison]::OrdinalIgnoreCase) -or
        ![string]::Equals($actions[0].WorkingDirectory, $Context.Root, [StringComparison]::OrdinalIgnoreCase) -or
        $task.Description -cne $expected.Description) { throw 'task_not_owned; nothing changed' }
    return $task
}

function Get-ChatwebDesktop { return [Environment]::GetFolderPath('DesktopDirectory') }

function Get-ChatwebShortcutDescriptor($Context, [string]$Name) {
    if ([string]::IsNullOrWhiteSpace($Name) -or $Name.Length -gt 120 -or $Name -match '[<>:"/\\|?*\x00-\x1f]' -or $Name -match '[ .]$') { throw 'invalid_shortcut_name' }
    $desktop = Get-ChatwebDesktop
    if (!$desktop -or !(Test-Path -LiteralPath $desktop -PathType Container)) { throw 'desktop_directory_missing' }
    [pscustomobject]@{
        Path=(Join-Path $desktop ($Name + '.lnk'))
        Target=$Context.PowerShellPath
        Arguments=('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ' +
            (ConvertTo-ChatwebArgument $Context.ManagerPath) + ' -Action Start -ConfigPath ' + (ConvertTo-ChatwebArgument $Context.ConfigPath) +
            ' -NodePath ' + (ConvertTo-ChatwebArgument $Context.NodePath) + ' -TaskName ' + (ConvertTo-ChatwebArgument $Context.TaskName))
        Description=('chatweb-bridge/windows-v1 Start ' + $Context.ConfigId)
    }
}

function Assert-ChatwebShortcutOwned($Descriptor) {
    if (!(Test-Path -LiteralPath $Descriptor.Path)) { return }
    $shell = New-Object -ComObject WScript.Shell
    try {
        $link = $shell.CreateShortcut($Descriptor.Path)
        if (![string]::Equals($link.TargetPath, $Descriptor.Target, [StringComparison]::OrdinalIgnoreCase) -or
            ![string]::Equals($link.Arguments, $Descriptor.Arguments, [StringComparison]::OrdinalIgnoreCase) -or
            $link.Description -cne $Descriptor.Description) { throw 'shortcut_not_owned; nothing changed' }
    } finally {
        if ($link) { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
        $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
    }
}

function Set-ChatwebShortcut($Context, $Descriptor) {
    Assert-ChatwebShortcutOwned $Descriptor
    $shell = New-Object -ComObject WScript.Shell
    try {
        $link = $shell.CreateShortcut($Descriptor.Path)
        $link.TargetPath = $Descriptor.Target
        $link.Arguments = $Descriptor.Arguments
        $link.Description = $Descriptor.Description
        $link.WorkingDirectory = $Context.Root
        # The PowerShell argument, not the .lnk window flag, hides the process.
        $link.WindowStyle = 7
        $link.Save()
    } finally {
        if ($link) { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
        $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
    }
    Assert-ChatwebShortcutOwned $Descriptor
}

function Write-ChatwebJson([string]$Path, $Value) {
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 10 -Compress), (New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally { if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) } }
}

function Invoke-ChatwebManagement {
    param($Context, [ValidateSet('Install','Start','Stop','Status','Uninstall')][string]$Action,
        [string]$DesktopShortcutName = 'Chatweb Bridge', [ValidateRange(45,300)][int]$StartupTimeoutSeconds = 60)
    $task = Get-ChatwebOwnedTask $Context
    if ($Action -eq 'Install') {
        $shortcut = Get-ChatwebShortcutDescriptor $Context $DesktopShortcutName
        Assert-ChatwebShortcutOwned $shortcut
        $installed = Read-ChatwebJson $Context.InstallFile
        if ($installed -and ($installed.configPath -ine $Context.ConfigPath -or $installed.taskName -ine $Context.TaskName)) { throw 'state_directory_not_owned' }
        if (!$task) {
            $descriptor = Get-ChatwebTaskDescriptor $Context
            $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
            $actionSpec = New-ScheduledTaskAction -Execute $descriptor.Execute -Argument $descriptor.Arguments -WorkingDirectory $Context.Root
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
            $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
            $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
            Register-ScheduledTask -TaskName $Context.TaskName -TaskPath '\' -Action $actionSpec -Trigger $trigger -Principal $principal -Settings $settings -Description $descriptor.Description -ErrorAction Stop | Out-Null
            if (!(Get-ChatwebOwnedTask $Context)) { throw 'task_registration_not_verified' }
        }
        $null = [IO.Directory]::CreateDirectory($Context.StateDir)
        Set-ChatwebShortcut $Context $shortcut
        Write-ChatwebJson $Context.InstallFile ([ordered]@{configPath=$Context.ConfigPath;nodePath=$Context.NodePath;taskName=$Context.TaskName;shortcutName=$DesktopShortcutName})
        return [pscustomobject]@{action='Install';installed=$true;started=$false;taskName=$Context.TaskName;shortcut=$shortcut.Path}
    }
    Assert-ChatwebStateOwned $Context
    if ($Action -ne 'Status' -and !$task) { throw 'task_not_installed; run Install first' }
    $mutex = Enter-ChatwebMutex $Context 'management' 10000
    if (!$mutex) { throw 'another_management_operation_is_running' }
    try {
        $owner = Read-ChatwebJson $Context.OwnerFile
        $health = Get-ChatwebHealth $Context $owner.child
        if ($Action -eq 'Status') {
            $ready = if ($health) { Invoke-ChatwebHttp $Context '/ready' -Authenticated } else { $null }
            return [pscustomobject]@{ action='Status'; installed=[bool]$task; running=[bool]$health;
                browserReady=($ready -and $ready.statusCode -eq 200 -and $ready.body.ready -eq $true);
                health=$health; phase=$owner.phase; logs=(Join-Path $Context.StateDir 'logs') }
        }
        if ($Action -eq 'Start') {
            if ($health -and !(Test-Path -LiteralPath $Context.StopFile)) {
                $ready = Invoke-ChatwebHttp $Context '/ready' -Authenticated
                return [pscustomobject]@{ action='Start'; running=$true; alreadyRunning=$true;
                    browserReady=($ready -and $ready.statusCode -eq 200 -and $ready.body.ready -eq $true); health=$health }
            }
            if (Test-ChatwebPortConflict $Context $owner.child) { throw 'port_in_use_not_owned; no process was stopped' }
            $null = [IO.Directory]::CreateDirectory($Context.StateDir)
            if (Test-Path -LiteralPath $Context.StopFile) {
                if (Test-ChatwebProcessRecord $Context $owner.supervisor 'supervisor') { throw 'stop_in_progress; retry Start after Stop completes' }
                [IO.File]::Delete($Context.StopFile)
            }
            $null = Get-ChatwebOwnedTask $Context
            Start-ScheduledTask -TaskName $Context.TaskName -TaskPath '\' -ErrorAction Stop
            $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
            do {
                $owner = Read-ChatwebJson $Context.OwnerFile
                $health = Get-ChatwebHealth $Context $owner.child
                if ($health) {
                    $ready = Invoke-ChatwebHttp $Context '/ready' -Authenticated
                    return [pscustomobject]@{ action='Start'; running=$true; alreadyRunning=$false;
                        browserReady=($ready -and $ready.statusCode -eq 200 -and $ready.body.ready -eq $true); health=$health }
                }
                # Node may bind before its verified PID record is published.
                # During our own bounded startup wait, do not mislabel that gap
                # as a foreign listener. No PID is killed by this path.
                Start-Sleep -Milliseconds 300
            } while ([DateTime]::UtcNow -lt $deadline)
            throw 'startup_deadline_expired; inspect stateDir/logs and windows-owner.json'
        }
        $shortcut = $null
        if ($Action -eq 'Uninstall') {
            $installed = Read-ChatwebJson $Context.InstallFile
            $name = if ($installed) { [string]$installed.shortcutName } else { $DesktopShortcutName }
            $shortcut = Get-ChatwebShortcutDescriptor $Context $name
            Assert-ChatwebShortcutOwned $shortcut
        }
        $null = [IO.Directory]::CreateDirectory($Context.StateDir)
        [IO.File]::WriteAllText($Context.StopFile, 'requested', (New-Object Text.UTF8Encoding($false)))
        Stop-ChatwebChild $Context $owner.child
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        while ((Test-ChatwebProcessRecord $Context $owner.supervisor 'supervisor') -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
        $null = Get-ChatwebOwnedTask $Context
        Stop-ScheduledTask -TaskName $Context.TaskName -TaskPath '\' -ErrorAction Stop
        if (Test-ChatwebProcessRecord $Context $owner.supervisor 'supervisor') { $null = Stop-ChatwebVerifiedProcess $Context $owner.supervisor 'supervisor' }
        if ((Test-ChatwebProcessRecord $Context $owner.child 'child') -or (Test-ChatwebProcessRecord $Context $owner.supervisor 'supervisor')) { throw 'owned_service_did_not_stop' }
        if ($Action -eq 'Uninstall') {
            $null = Get-ChatwebOwnedTask $Context
            Unregister-ScheduledTask -TaskName $Context.TaskName -TaskPath '\' -Confirm:$false -ErrorAction Stop
            if (Get-ChatwebOwnedTask $Context) { throw 'task_removal_not_verified' }
            if (Test-Path -LiteralPath $shortcut.Path) { [IO.File]::Delete($shortcut.Path) }
            if (Test-Path -LiteralPath $Context.InstallFile) { [IO.File]::Delete($Context.InstallFile) }
        }
        return [pscustomobject]@{ action=$Action; stopped=$true; uninstalled=($Action -eq 'Uninstall'); userDataPreserved=$true }
    } finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    try {
        $context = Get-ChatwebContext -ConfigPath $ConfigPath -NodePath $NodePath -TaskName $TaskName
        Invoke-ChatwebManagement -Context $context -Action $Action -DesktopShortcutName $DesktopShortcutName -StartupTimeoutSeconds $StartupTimeoutSeconds | ConvertTo-Json -Depth 6
    } catch { Write-Error ('chatweb_windows_failed: ' + $_.Exception.Message); exit 1 }
}
