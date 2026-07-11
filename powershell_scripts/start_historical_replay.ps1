$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'python_launcher_common.ps1')

$projectRoot = Split-Path -Parent $PSScriptRoot
$python = (Resolve-OptionComboPython -ProjectRoot $projectRoot).Path
$workdir = $projectRoot

# Historical replay data now comes from the shared options-chain-service
# (Options DB workspace). Start it first if it is not already running.
$chainServiceUrl = 'http://127.0.0.1:8750'
$chainServiceScript = Join-Path $projectRoot '..\..\Options DB\chain_service\chain_server.py'

$chainServiceUp = $false
try {
    $response = Invoke-WebRequest -Uri "$chainServiceUrl/health" -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200) { $chainServiceUp = $true }
} catch { }

if (-not $chainServiceUp) {
    if (Test-Path $chainServiceScript) {
        $chainServiceDir = Split-Path -Parent $chainServiceScript
        $chainCommand = 'cd /d "{0}" && "{1}" chain_server.py' -f $chainServiceDir, $python
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $chainCommand -WorkingDirectory $chainServiceDir | Out-Null
        Write-Host "Starting options chain service: $chainServiceScript"
    } else {
        Write-Warning "Options chain service not reachable at $chainServiceUrl and script not found at $chainServiceScript."
        Write-Warning "Historical replay will fail until the chain service is running."
    }
} else {
    Write-Host "Options chain service already running at $chainServiceUrl"
}

$httpCommand = 'cd /d "{0}" && "{1}" -m http.server 8000' -f $workdir, $python
$historicalCommand = 'cd /d "{0}" && "{1}" historical_server.py' -f $workdir, $python

Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $httpCommand -WorkingDirectory $workdir | Out-Null
Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $historicalCommand -WorkingDirectory $workdir | Out-Null

Write-Host 'Started:'
Write-Host '  - Frontend: http://localhost:8000/index.html?entry=historical&marketDataMode=historical&lockMarketDataMode=1'
Write-Host '  - Historical replay backend: ws://localhost:8765'
Write-Host "  - Options chain service: $chainServiceUrl"
Write-Host ''
Write-Host "Python: $python"
