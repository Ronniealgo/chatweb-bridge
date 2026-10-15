# Shared Windows helpers and hidden child supervisor. Dot-sourcing is inert.
[CmdletBinding()]
param(
    [string]$ConfigPath, [string]$NodePath, [string]$TaskName = 'chatweb-bridge',
    [ValidateRange(4096, 16777216)][int]$LogMaxBytes = 1048576,
    [ValidateRange(1, 10)][int]$LogKeepFiles = 3
)

$script:ChatwebScriptsRoot = $PSScriptRoot

function Initialize-ChatwebNative {
    if ('Chatweb.Windows.Native' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
namespace Chatweb.Windows {
    public static class Native {
        [DllImport("shell32.dll", SetLastError=true)]
        static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string line, out int count);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
        public static string[] Split(string line) {
            int count; IntPtr memory = CommandLineToArgvW(line, out count);
            if (memory == IntPtr.Zero) throw new InvalidOperationException("command_line_parse_failed");
            try {
                string[] result = new string[count];
                for (int i=0; i<count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i*IntPtr.Size));
                return result;
            } finally { LocalFree(memory); }
        }
    }
    // The callbacks run entirely in .NET: no PowerShell runspace/event queue,
    // unbounded ReadLine allocation, or stdout/stderr pipe deadlock.
    public sealed class LogPump {
        readonly Task output, error;
        public LogPump(System.Diagnostics.Process child, string directory, int limit, int keep, string secret) {
            Directory.CreateDirectory(directory);
            output = Task.Run(() => Pump(child.StandardOutput, new Log(Path.Combine(directory, "stdout.log"), limit, keep, secret)));
            error = Task.Run(() => Pump(child.StandardError, new Log(Path.Combine(directory, "stderr.log"), limit, keep, secret)));
        }
        public bool Failed { get { return output.IsFaulted || error.IsFaulted; } }
        public void Complete() { Task.WaitAll(new Task[] { output, error }, 3000); }
        static async Task Pump(StreamReader reader, Log log) {
            char[] buffer = new char[2048];
            StringBuilder line = new StringBuilder();
            bool overlong = false;
            int count;
            while ((count = await reader.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) != 0) {
                for (int i = 0; i < count; i++) {
                    if (buffer[i] == '\n') {
                        log.Write(overlong ? "[overlong log line omitted]" : line.ToString().TrimEnd('\r'));
                        line.Clear(); overlong = false;
                    } else if (!overlong) {
                        if (line.Length >= 8192) { line.Clear(); overlong = true; }
                        else line.Append(buffer[i]);
                    }
                }
            }
            if (overlong || line.Length > 0) log.Write(overlong ? "[overlong log line omitted]" : line.ToString());
        }
        sealed class Log {
            readonly string path, secret;
            readonly int limit, keep;
            readonly Encoding utf8 = new UTF8Encoding(false);
            public Log(string path, int limit, int keep, string secret) {
                this.path = path; this.limit = limit; this.keep = keep; this.secret = secret;
            }
            public void Write(string line) {
                if (!String.IsNullOrEmpty(secret)) line = line.Replace(secret, "[redacted]");
                if (Regex.IsMatch(line, @"(?i)(authorization\s*:|(?:^|\s)prompt\s*:|[\""']?(?:access_?token|api_?key|password)[\""']?\s*[:=])"))
                    line = "[sensitive log line omitted]";
                byte[] bytes = utf8.GetBytes(line + Environment.NewLine);
                if (bytes.Length > limit) bytes = utf8.GetBytes("[overlong log line omitted]" + Environment.NewLine);
                if (File.Exists(path) && new FileInfo(path).Length + bytes.Length > limit) {
                    if (File.Exists(path + "." + keep)) File.Delete(path + "." + keep);
                    for (int i = keep - 1; i >= 1; i--)
                        if (File.Exists(path + "." + i)) File.Move(path + "." + i, path + "." + (i + 1));
                    File.Move(path, path + ".1");
                }
                using (FileStream stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
                    stream.Write(bytes, 0, bytes.Length);
            }
        }
    }
}
'@
}

function ConvertTo-ChatwebArgument([string]$Value) {
    if ($Value -match '[\x00-\x1f]') { throw 'control_character_in_argument' }
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Split-ChatwebCommandLine([string]$Line) {
    Initialize-ChatwebNative
    return [Chatweb.Windows.Native]::Split($Line)
}

function Get-ChatwebHash([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Resolve-ChatwebPath([string]$Value, [string]$Base) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -match '[\x00-\x1f"]') { throw 'invalid_path' }
    if (![IO.Path]::IsPathRooted($Value)) { $Value = Join-Path $Base $Value }
    return [IO.Path]::GetFullPath($Value)
}

function Read-ChatwebJson([string]$Path) {
    if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json }
    catch { throw 'invalid_json_file' }
}

function Get-ChatwebContext([string]$ConfigPath, [string]$NodePath, [string]$TaskName = 'chatweb-bridge') {
    if (![IO.Path]::IsPathRooted($ConfigPath)) { throw 'config_path_must_be_absolute' }
    if ($TaskName -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$') { throw 'invalid_task_name' }
    $fullConfig = Resolve-ChatwebPath $ConfigPath $script:ChatwebScriptsRoot
    $config = Read-ChatwebJson $fullConfig
    if (!$config) { throw 'config_file_missing' }
    if (@('127.0.0.1', '::1', 'localhost') -notcontains [string]$config.host) { throw 'host_must_be_loopback' }
    $port = 0
    if (![int]::TryParse([string]$config.port, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw 'invalid_port' }
    if ($null -eq $config.providers -or $config.providers -isnot [array]) { throw 'providers_must_be_array' }
    $base = Split-Path -Parent $fullConfig
    $stateDir = Resolve-ChatwebPath ([string]$config.stateDir) $base
    $authFile = Resolve-ChatwebPath ([string]$config.authFile) $base
    $installFile = Join-Path $stateDir 'windows-install.json'
    if (!$NodePath) {
        $installed = Read-ChatwebJson $installFile
        if ($installed -and [string]::Equals($installed.configPath, $fullConfig, [StringComparison]::OrdinalIgnoreCase)) { $NodePath = [string]$installed.nodePath }
    }
    if (!$NodePath) { $NodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
    $node = Resolve-ChatwebPath $NodePath $base
    if (!(Test-Path -LiteralPath $node -PathType Leaf)) { throw 'node_executable_missing' }
    $root = [IO.Path]::GetFullPath((Join-Path $script:ChatwebScriptsRoot '..'))
    $bridge = Join-Path $root 'web-bridge.mjs'
    if (!(Test-Path -LiteralPath $bridge -PathType Leaf)) { throw 'bridge_entry_missing' }
    $configId = Get-ChatwebHash $fullConfig.ToLowerInvariant()
    $hostValue = [string]$config.host
    if ($hostValue -eq '::1') { $hostValue = '[::1]' }
    [pscustomobject]@{
        ConfigPath=$fullConfig; ConfigId=$configId; StateDir=$stateDir; AuthFile=$authFile
        NodePath=$node; ScriptPath=$bridge; Root=$root; TaskName=$TaskName
        SupervisorPath=(Join-Path $script:ChatwebScriptsRoot 'universal-supervisor.ps1')
        ManagerPath=(Join-Path $script:ChatwebScriptsRoot 'universal-windows.ps1')
        PowerShellPath=(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
        OwnerFile=(Join-Path $stateDir 'windows-owner.json'); StopFile=(Join-Path $stateDir 'windows-stop.request')
        InstallFile=$installFile; BaseUrl=('http://{0}:{1}' -f $hostValue, $port); Port=$port
    }
}

function Get-ChatwebChildArguments($Context) {
    return (ConvertTo-ChatwebArgument $Context.ScriptPath) + ' serve --config ' + (ConvertTo-ChatwebArgument $Context.ConfigPath)
}

function Write-ChatwebJson([string]$Path, $Value) {
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 10 -Compress), (New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally { if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) } }
}

function Assert-ChatwebStateOwned($Context) {
    foreach ($path in @($Context.OwnerFile, $Context.InstallFile)) {
        $record = Read-ChatwebJson $path
        if ($record -and ($record.configPath -ine $Context.ConfigPath -or $record.taskName -ine $Context.TaskName)) { throw 'state_directory_not_owned' }
    }
}

function Enter-ChatwebMutex($Context, [string]$Kind, [int]$TimeoutMilliseconds = 0) {
    $mutex = New-Object Threading.Mutex($false, ('Local\chatweb-bridge-' + $Kind + '-' + $Context.ConfigId))
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne($TimeoutMilliseconds) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if ($acquired) { return $mutex }
    } finally { if (!$acquired) { $mutex.Dispose() } }
    return $null
}

function Get-ChatwebProcessRecord($Context, [int]$ProcessId, [string]$Kind) {
    $processInfo = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $ProcessId) -ErrorAction Stop
    if (!$processInfo -or !$processInfo.CommandLine -or !$processInfo.ExecutablePath) { return $null }
    return [pscustomobject]@{
        pid=$ProcessId; creationTimeUtc=$processInfo.CreationDate.ToUniversalTime().ToString('o')
        commandLine=[string]$processInfo.CommandLine; executablePath=[string]$processInfo.ExecutablePath
        configPath=$Context.ConfigPath; kind=$Kind
    }
}

function Test-ChatwebProcessRecord($Context, $Record, [string]$Kind) {
    if (!$Record -or $Record.kind -cne $Kind -or $Record.configPath -ine $Context.ConfigPath -or $Record.pid -le 0) { return $false }
    try {
        $current = Get-ChatwebProcessRecord $Context ([int]$Record.pid) $Kind
        if (!$current -or $current.creationTimeUtc -cne $Record.creationTimeUtc -or $current.commandLine -cne $Record.commandLine -or
            $current.executablePath -ine $Record.executablePath) { return $false }
        $arguments = @(Split-ChatwebCommandLine $current.commandLine)
        if ($Kind -eq 'child') {
            $expected = @($Context.NodePath, $Context.ScriptPath, 'serve', '--config', $Context.ConfigPath)
            if ($current.executablePath -ine $Context.NodePath -or $arguments.Count -ne $expected.Count) { return $false }
            for ($i = 0; $i -lt $expected.Count; $i++) { if ($arguments[$i] -ine $expected[$i]) { return $false } }
        } elseif ($Kind -eq 'supervisor') {
            if ($current.executablePath -ine $Context.PowerShellPath) { return $false }
            # Require the actual script and exact config, not a substring in -Command.
            foreach ($pair in @(@('-File', $Context.SupervisorPath), @('-ConfigPath', $Context.ConfigPath), @('-NodePath', $Context.NodePath))) {
                $positions = @(for ($i = 1; $i -lt $arguments.Count; $i++) { if ($arguments[$i] -ieq $pair[0]) { $i } })
                if ($positions.Count -ne 1 -or $positions[0] + 1 -ge $arguments.Count -or $arguments[$positions[0] + 1] -ine $pair[1]) { return $false }
            }
            if (@($arguments | Where-Object { $_ -imatch '^-(?:Command|EncodedCommand|c|ec)$' }).Count) { return $false }
        } else { return $false }
        return $true
    } catch { return $false }
}

function Stop-ChatwebVerifiedProcess($Context, $Record, [string]$Kind) {
    if (!$Record) { return $false }
    $process = $null
    try {
        $process = [Diagnostics.Process]::GetProcessById([int]$Record.pid)
        # Open and retain the native handle before validation; PID reuse cannot
        # redirect Kill() to a different process between the check and the kill.
        $null = $process.Handle
        if (!(Test-ChatwebProcessRecord $Context $Record $Kind)) { return $false }
        if (!$process.HasExited) { $process.Kill(); $null = $process.WaitForExit(5000) }
        return $process.HasExited
    } catch [ArgumentException] { return $true }
    catch [InvalidOperationException] { return $true }
    finally { if ($process) { $process.Dispose() } }
}

function Get-ChatwebPortOwners($Context) {
    $listening = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $Context.Port })
    if (!$listening.Count) { return @() }
    # Query only this configured port. No process enumeration or name-based kill.
    $connections = @(Get-NetTCPConnection -LocalPort $Context.Port -State Listen -ErrorAction SilentlyContinue)
    if (!$connections.Count) {
        # A listener may have disappeared between the two snapshots.
        if (@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $Context.Port }).Count) { throw 'listener_lookup_failed' }
        return @()
    }
    return @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Test-ChatwebPortConflict($Context, $Child) {
    $owners = @(Get-ChatwebPortOwners $Context)
    if (!$owners.Count) { return $false }
    if (!(Test-ChatwebProcessRecord $Context $Child 'child')) { return $true }
    return @($owners | Where-Object { $_ -ne $Child.pid }).Count -gt 0
}

function Read-ChatwebToken($Context) {
    if (!(Test-Path -LiteralPath $Context.AuthFile -PathType Leaf)) { return $null }
    try {
        $text = [IO.File]::ReadAllText($Context.AuthFile, [Text.Encoding]::UTF8).Trim()
        if ($text.StartsWith('{')) { $token = [string](($text | ConvertFrom-Json).token) } else { $token = $text }
        if ([string]::IsNullOrWhiteSpace($token) -or $token -match '[\x00-\x20\x7f]') { throw 'invalid_auth_file' }
        return $token
    } catch { throw 'invalid_auth_file' }
}

function Invoke-ChatwebHttp($Context, [string]$Path, [string]$Method = 'GET', [switch]$Authenticated) {
    $response = $null; $reader = $null
    try {
        $request = [Net.HttpWebRequest]::Create($Context.BaseUrl + $Path)
        $request.Proxy = $null; $request.AllowAutoRedirect = $false
        $request.Timeout = 2000; $request.ReadWriteTimeout = 2000; $request.KeepAlive = $false
        $request.Method = $Method
        if ($Authenticated) {
            $token = Read-ChatwebToken $Context
            if (!$token) { return $null }
            $request.Headers['Authorization'] = 'Bearer ' + $token
        }
        if ($Method -eq 'POST') {
            $body = [Text.Encoding]::UTF8.GetBytes('{}')
            $request.ContentType = 'application/json'; $request.ContentLength = $body.Length
            $stream = $request.GetRequestStream()
            try { $stream.Write($body, 0, $body.Length) } finally { $stream.Dispose() }
        }
        try { $response = $request.GetResponse() }
        catch [Net.WebException] { $response = $_.Exception.Response; if (!$response) { return $null } }
        $reader = New-Object IO.StreamReader($response.GetResponseStream(), [Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
        if ($text.Length -gt 65536) { return $null }
        return [pscustomobject]@{statusCode=[int]$response.StatusCode; body=($text | ConvertFrom-Json)}
    } catch { return $null }
    finally { if ($reader) { $reader.Dispose() }; if ($response) { $response.Dispose() } }
}

function Get-ChatwebHealth($Context, $Child) {
    if (!(Test-ChatwebProcessRecord $Context $Child 'child') -or (Test-ChatwebPortConflict $Context $Child)) { return $null }
    $response = Invoke-ChatwebHttp $Context '/health'
    if (!$response -or $response.statusCode -ne 200) { return $null }
    $health = $response.body
    if ($health.service -cne 'chatweb-bridge' -or $health.version -cne '0.3.0' -or
        [string]::IsNullOrWhiteSpace([string]$health.instanceId) -or $health.pid -ne $Child.pid -or
        @('ok', 'degraded') -cnotcontains $health.status -or $health.quarantined -isnot [bool]) { return $null }
    return $health
}

function Stop-ChatwebChild($Context, $Child, [int]$GraceSeconds = 10) {
    if (!(Test-ChatwebProcessRecord $Context $Child 'child')) { return }
    if (Get-ChatwebHealth $Context $Child) { $null = Invoke-ChatwebHttp $Context '/admin/shutdown' 'POST' -Authenticated }
    $deadline = [DateTime]::UtcNow.AddSeconds($GraceSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (!(Test-ChatwebProcessRecord $Context $Child 'child')) { return }
        Start-Sleep -Milliseconds 200
    }
    $null = Stop-ChatwebVerifiedProcess $Context $Child 'child'
    if (Test-ChatwebProcessRecord $Context $Child 'child') { throw 'owned_child_did_not_stop' }
}

function Invoke-ChatwebSupervisor($Context, [int]$LogMaxBytes, [int]$LogKeepFiles) {
    $mutex = Enter-ChatwebMutex $Context 'supervisor'
    if (!$mutex) { return }
    $child = $null; $pump = $null; $owner = $null
    try {
        Assert-ChatwebStateOwned $Context
        if (Test-Path -LiteralPath $Context.StopFile) { return }
        $previous = Read-ChatwebJson $Context.OwnerFile
        $null = [IO.Directory]::CreateDirectory($Context.StateDir)
        $self = Get-ChatwebProcessRecord $Context $PID 'supervisor'
        if (!(Test-ChatwebProcessRecord $Context $self 'supervisor')) { throw 'supervisor_identity_not_verified' }
        $owner = [ordered]@{schema=1;configPath=$Context.ConfigPath;taskName=$Context.TaskName;sessionId=[Guid]::NewGuid().ToString('N');supervisor=$self;child=$null;phase='starting';restartCount=0;nextRestartDelayMs=0}
        # Recover a verified orphan without starting a duplicate listener.
        if ($previous -and (Test-ChatwebProcessRecord $Context $previous.child 'child')) {
            $owner.child = $previous.child
            $child = [Diagnostics.Process]::GetProcessById([int]$previous.child.pid)
            $null = $child.Handle
        }
        Write-ChatwebJson $Context.OwnerFile $owner
        $failures = 0
        while (!(Test-Path -LiteralPath $Context.StopFile)) {
            if (!$child) {
                if (Test-ChatwebPortConflict $Context $null) { throw 'port_in_use_not_owned' }
                Initialize-ChatwebNative
                $info = New-Object Diagnostics.ProcessStartInfo
                $info.FileName = $Context.NodePath; $info.Arguments = Get-ChatwebChildArguments $Context
                $info.WorkingDirectory = $Context.Root
                $info.UseShellExecute = $false; $info.CreateNoWindow = $true
                $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
                $info.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
                $info.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
                $child = New-Object Diagnostics.Process
                $child.StartInfo = $info
                if (Test-Path -LiteralPath $Context.StopFile) { break }
                $secret = Read-ChatwebToken $Context
                if (!$child.Start()) { throw 'child_start_failed' }
                $pump = New-Object Chatweb.Windows.LogPump($child, (Join-Path $Context.StateDir 'logs'), $LogMaxBytes, $LogKeepFiles, $secret)
                $record = Get-ChatwebProcessRecord $Context $child.Id 'child'
                if ($record -and !(Test-ChatwebProcessRecord $Context $record 'child')) { throw 'child_identity_not_verified' }
                $owner.child = $record
                $owner.phase = 'running'; $owner.nextRestartDelayMs = 0
                Write-ChatwebJson $Context.OwnerFile $owner
            }
            $started = [DateTime]::UtcNow
            while (!$child.HasExited -and !(Test-Path -LiteralPath $Context.StopFile)) {
                if ($pump -and $pump.Failed) { throw 'child_log_capture_failed' }
                Start-Sleep -Milliseconds 200
                $child.Refresh()
            }
            if (Test-Path -LiteralPath $Context.StopFile) { break }
            if ($pump) { $pump.Complete(); $pump = $null }
            $owner.lastExitCode = $child.ExitCode
            $child.Dispose(); $child = $null
            if (([DateTime]::UtcNow - $started).TotalSeconds -ge 60) { $failures = 0 }
            $delay = [int][Math]::Min(30000, 1000 * [Math]::Pow(2, [Math]::Min($failures, 5)))
            $failures++; $owner.restartCount++; $owner.child = $null; $owner.phase = 'backoff'; $owner.nextRestartDelayMs = $delay
            Write-ChatwebJson $Context.OwnerFile $owner
            $deadline = [DateTime]::UtcNow.AddMilliseconds($delay)
            while ([DateTime]::UtcNow -lt $deadline -and !(Test-Path -LiteralPath $Context.StopFile)) { Start-Sleep -Milliseconds 100 }
        }
    } finally {
        try {
            if ($owner) {
                Stop-ChatwebChild $Context $owner.child
                if ($pump) { $pump.Complete() }
                $owner.child = $null; $owner.supervisor = $null; $owner.phase = 'stopped'
                Write-ChatwebJson $Context.OwnerFile $owner
            }
        } finally {
            if ($child) { $child.Dispose() }
            $mutex.ReleaseMutex(); $mutex.Dispose()
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    try {
        $context = Get-ChatwebContext -ConfigPath $ConfigPath -NodePath $NodePath -TaskName $TaskName
        Invoke-ChatwebSupervisor $context $LogMaxBytes $LogKeepFiles
    } catch { Write-Error ('chatweb_supervisor_failed: ' + $_.Exception.Message); exit 1 }
}
