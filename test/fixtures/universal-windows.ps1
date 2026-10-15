param([string]$Mode, [string]$Root, [string]$Config, [string]$Node, [string]$Case)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$supervisor = Join-Path $Root 'scripts\universal-supervisor.ps1'
$manager = Join-Path $Root 'scripts\universal-windows.ps1'
$parseErrors = 0
foreach ($file in @($supervisor, $manager)) {
    $tokens = $null; $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
    $parseErrors += @($errors).Count
}
if ($parseErrors) { throw 'PowerShell parser errors' }
. $supervisor
. $manager
$context = Get-ChatwebContext -ConfigPath $Config -NodePath $Node
if ($Mode -eq 'context') {
    $argsLine = (ConvertTo-ChatwebArgument $context.NodePath) + ' ' + (Get-ChatwebChildArguments $context)
    [ordered]@{
        parseErrors=$parseErrors; hasState=(Test-Path $context.StateDir)
        configPath=$context.ConfigPath; scriptPath=$context.ScriptPath
        nodePath=$context.NodePath; configId=$context.ConfigId
        args=@(Split-ChatwebCommandLine $argsLine)
    } | ConvertTo-Json -Compress -Depth 5
} elseif ($Mode -eq 'tasks') {
    $global:FixtureTask = $null
    $global:Registered = 0; $global:Started = 0; $global:Stopped = 0; $global:Removed = 0
    $global:FixtureDesktop = Join-Path (Split-Path -Parent $Config) 'desktop'
    $null = New-Item -ItemType Directory -Path $global:FixtureDesktop -Force
    function global:Get-ChatwebDesktop { return $global:FixtureDesktop }
    function global:Get-ScheduledTask {
        param($TaskName, $TaskPath, $ErrorAction)
        if ($Case -eq 'lookup-error') { throw 'synthetic_lookup_error' }
        return $global:FixtureTask
    }
    function global:New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory) return [pscustomobject]@{Execute=$Execute;Arguments=$Argument;WorkingDirectory=$WorkingDirectory} }
    function global:New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User) return [pscustomobject]@{AtLogOn=[bool]$AtLogOn;User=$User} }
    function global:New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) return [pscustomobject]@{UserId=$UserId;LogonType=$LogonType;RunLevel=$RunLevel} }
    function global:New-ScheduledTaskSettingsSet {
        param([switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, [switch]$Hidden, $ExecutionTimeLimit, $MultipleInstances, $RestartCount, $RestartInterval)
        return [pscustomobject]@{MultipleInstances=$MultipleInstances;ExecutionTimeLimit=$ExecutionTimeLimit.ToString();Hidden=[bool]$Hidden;RestartCount=$RestartCount}
    }
    function global:Register-ScheduledTask {
        param($TaskName, $TaskPath, $Action, $Trigger, $Principal, $Settings, $Description, [switch]$Force, $ErrorAction)
        $global:Registered++
        $global:FixtureTask = [pscustomobject]@{Actions=@($Action);Triggers=@($Trigger);Principal=$Principal;Settings=$Settings;Description=$Description;State='Ready'}
        return $global:FixtureTask
    }
    function global:Start-ScheduledTask { param($TaskName, $TaskPath, $ErrorAction) $global:Started++ }
    function global:Stop-ScheduledTask { param($TaskName, $TaskPath, $ErrorAction) $global:Stopped++; $global:FixtureTask.State='Ready' }
    function global:Unregister-ScheduledTask { param($TaskName, $TaskPath, $Confirm, $ErrorAction) $global:Removed++; $global:FixtureTask=$null }
    $global:LifecycleResults = @()
    $failure = $null
    try {
        if ($Case -like 'foreign-*') {
            $descriptor = Get-ChatwebTaskDescriptor $context
            $global:FixtureTask = [pscustomobject]@{ Actions=@([pscustomobject]@{Execute=$descriptor.Execute;Arguments=$descriptor.Arguments;WorkingDirectory=$context.Root});Description=$descriptor.Description;State='Ready' }
            if ($Case -like 'foreign-action-*') { $global:FixtureTask.Actions[0].Arguments += ' -Other value' }
            else { $global:FixtureTask.Description = 'some other application' }
            $actionName = ($Case -split '-')[-1]
            $null = Invoke-ChatwebManagement -Context $context -Action $actionName -DesktopShortcutName 'Fixture bridge'
        } else {
            $null = Invoke-ChatwebManagement -Context $context -Action Install -DesktopShortcutName 'Fixture bridge'
            $null = Invoke-ChatwebManagement -Context $context -Action Install -DesktopShortcutName 'Fixture bridge'
            if ($Case -eq 'owned-lifecycle') {
                function global:Test-ChatwebPortConflict { param($Context,$Child) return $false }
                function global:Test-ChatwebProcessRecord { param($Context,$Record,$Kind) return $false }
                function global:Get-ChatwebHealth { param($Context,$Child) if ($global:Started -gt 0 -and !(Test-Path $Context.StopFile)) { return [pscustomobject]@{service='chatweb-bridge';pid=456;instanceId='fixture';status='ok';quarantined=$false} } }
                function global:Invoke-ChatwebHttp { param($Context,$Path,$Method,[switch]$Authenticated) return [pscustomobject]@{statusCode=503;body=[pscustomobject]@{ready=$false}} }
                function global:Stop-ChatwebChild { param($Context,$Child,$GraceSeconds) }
                foreach ($actionName in @('Start','Start','Status','Stop','Uninstall')) {
                    $global:LifecycleResults += Invoke-ChatwebManagement -Context $context -Action $actionName -DesktopShortcutName 'Fixture bridge'
                }
            }
        }
    } catch { $failure=$_.Exception.Message }
    $shortcutPath = Join-Path $global:FixtureDesktop 'Fixture bridge.lnk'
    $shortcut = $null
    if (Test-Path -LiteralPath $shortcutPath) {
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut($shortcutPath)
        $shortcut = [pscustomobject]@{TargetPath=$link.TargetPath;Arguments=$link.Arguments;WindowStyle=$link.WindowStyle;Description=$link.Description}
    }
    [ordered]@{lifecycle=$global:LifecycleResults;failure=$failure;registered=$global:Registered;started=$global:Started;stopped=$global:Stopped;removed=$global:Removed;task=$global:FixtureTask;shortcut=$shortcut;hasState=(Test-Path $context.StateDir)} | ConvertTo-Json -Compress -Depth 8
} else { throw 'Unknown fixture mode' }
