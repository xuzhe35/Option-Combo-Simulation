$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'python_launcher_common.ps1')

$projectRoot = Split-Path -Parent $PSScriptRoot
$python = (Resolve-OptionComboPython -ProjectRoot $projectRoot).Path
$workdir = $projectRoot

# Historical replay data comes from an external, swappable options-chain-service.
# Where it lives is config, not knowledge this script owns: ask
# chain_service_config.py so config.ini and the env overrides stay the one
# source of truth. An empty script path means the service is remote and not
# ours to start. See config.ini [historical].
$chainServiceUrl = (& $python (Join-Path $projectRoot 'chain_service_config.py') --url).Trim()
$chainServiceScript = (& $python (Join-Path $projectRoot 'chain_service_config.py') --script).Trim()

$chainServiceUp = $false
try {
    $response = Invoke-WebRequest -Uri "$chainServiceUrl/health" -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200) { $chainServiceUp = $true }
} catch { }

if (-not $chainServiceUp) {
    if (-not $chainServiceScript) {
        Write-Warning "Options chain service not reachable at $chainServiceUrl."
        Write-Warning 'It is configured as remote (chain_service_dir is empty), so this script will not start it.'
        Write-Warning 'Historical replay will fail until that service answers.'
    } elseif (Test-Path $chainServiceScript) {
        $chainServiceDir = Split-Path -Parent $chainServiceScript
        # Deliberately the plain launcher python, not our venv: the chain
        # service is a separate project that brings its own dependencies.
        $chainCommand = 'cd /d "{0}" && "{1}" chain_server.py' -f $chainServiceDir, $python
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $chainCommand -WorkingDirectory $chainServiceDir | Out-Null
        Write-Host "Starting options chain service: $chainServiceScript"
    } else {
        Write-Warning "Options chain service not reachable at $chainServiceUrl and no chain_server.py at $chainServiceScript."
        Write-Warning 'Fix chain_service_dir in config.ini (or set OPTION_COMBO_CHAIN_SERVICE_DIR), or blank it if the service is remote.'
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
