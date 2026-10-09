$ErrorActionPreference = 'Stop'
# Stop only processes whose executable arguments name THIS delivered bridge.
$bridgeServerPath = Join-Path $PSScriptRoot 'server.mjs'
$bridgeAdapterPath = Join-Path $PSScriptRoot 'pcw.mjs'
$bridgeProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -and ($_.CommandLine.Contains($bridgeServerPath) -or $_.CommandLine.Contains($bridgeAdapterPath))
})
foreach ($bridgeProcess in $bridgeProcesses) {
    $managedChrome = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ParentProcessId -eq $bridgeProcess.ProcessId -and $_.Name -eq 'chrome.exe' -and $_.CommandLine -like '*--user-data-dir=*pi-chatgpt-web*profile*'
    })
    foreach ($browserProcess in $managedChrome) { Stop-Process -Id $browserProcess.ProcessId -ErrorAction SilentlyContinue }
    Stop-Process -Id $bridgeProcess.ProcessId -ErrorAction SilentlyContinue
}
Write-Output ('Stopped {0} bridge processes.' -f $bridgeProcesses.Count)
