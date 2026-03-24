$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'python_launcher_common.ps1')

$projectRoot = Split-Path -Parent $PSScriptRoot
$python = (Resolve-OptionComboPython -ProjectRoot $projectRoot).Path
$workdir = $projectRoot

$httpCommand = 'cd /d "{0}" && "{1}" -m http.server 8000' -f $workdir, $python
$historicalCommand = 'cd /d "{0}" && "{1}" historical_server.py' -f $workdir, $python

Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $httpCommand -WorkingDirectory $workdir | Out-Null
Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $historicalCommand -WorkingDirectory $workdir | Out-Null

Write-Host 'Started:'
Write-Host '  - Frontend: http://localhost:8000/index.html?entry=historical&marketDataMode=historical&lockMarketDataMode=1'
Write-Host '  - Historical replay backend: ws://localhost:8765'
Write-Host ''
Write-Host "Python: $python"
