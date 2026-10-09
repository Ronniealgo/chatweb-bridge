param([Parameter(ValueFromRemainingArguments=$true)][string[]]$TaskText)
$ErrorActionPreference = 'Stop'
if (!$TaskText -or $TaskText.Count -eq 0) { throw 'Usage: & ./run.ps1 "your task". Run from the workspace you want DSH to work in.' }
$taskNode = (Get-Command node -ErrorAction Stop).Source
& $taskNode (Join-Path $PSScriptRoot 'scripts/check-launch-auth.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Explicit local service authorization is required; no service or task started.' }
& $taskNode (Join-Path $PSScriptRoot 'manage.mjs') start
if ($LASTEXITCODE -ne 0) { throw 'Bridge startup failed.' }
    $taskDsh = (Get-Command dsh -ErrorAction Stop).Source
    & $taskDsh --profile headless --patch (Join-Path $PSScriptRoot 'dsh-chat-tools.patch.yml') @TaskText
    $taskExit = $LASTEXITCODE
exit $taskExit
