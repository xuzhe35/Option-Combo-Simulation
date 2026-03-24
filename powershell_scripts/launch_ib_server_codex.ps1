$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'python_launcher_common.ps1')

$projectRoot = Split-Path -Parent $PSScriptRoot
$python = (Resolve-OptionComboPython -ProjectRoot $projectRoot).Path
$workdir = $projectRoot
$stdout = Join-Path $workdir 'ib_server.codex.log'
$stderr = Join-Path $workdir 'ib_server.codex.err.log'
$pidFile = Join-Path $workdir 'ib_server.codex.pid'

$proc = Start-Process -FilePath $python `
    -ArgumentList 'ib_server.py' `
    -WorkingDirectory $workdir `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru

Set-Content -Path $pidFile -Value $proc.Id
Start-Sleep -Seconds 4
Get-Process -Id $proc.Id | Select-Object Id, ProcessName, Path
