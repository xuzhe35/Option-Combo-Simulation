$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'python_launcher_common.ps1')

$projectRoot = Split-Path -Parent $PSScriptRoot
$python = (Resolve-OptionComboPython -ProjectRoot $projectRoot).Path
$workdir = $projectRoot

$httpCommand = 'cd /d "{0}" && "{1}" -m http.server 8000' -f $workdir, $python
$ibCommand = 'cd /d "{0}" && "{1}" ib_server.py' -f $workdir, $python

Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $httpCommand -WorkingDirectory $workdir | Out-Null
Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $ibCommand -WorkingDirectory $workdir | Out-Null

Write-Host 'Started:'
Write-Host '  - Frontend: http://localhost:8000/index.html?entry=live&marketDataMode=live&lockMarketDataMode=1'
Write-Host '  - IB bridge: ws://localhost:8765'
Write-Host ''
Write-Host "Python: $python"
