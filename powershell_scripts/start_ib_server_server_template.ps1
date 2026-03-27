$ErrorActionPreference = 'Stop'

# ==================== EDIT THESE FOR YOUR SERVER ====================
$ProjectRoot = 'C:\REPLACE_WITH_SERVER_PROJECT_ROOT\Option Combo Simulation'

# Optional: leave blank to auto-resolve via config.local.ini / config.ini / .venv / common installs / PATH.
$PythonExecutable = ''

$PidFileName = 'ib_server.server.pid'
$StdoutLogName = 'ib_server.server.log'
$StderrLogName = 'ib_server.server.err.log'

# Set to $true to stop the process recorded in the pid file before starting a new one.
$StopExistingProcess = $true
# ====================================================================

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'python_launcher_common.ps1')

if (-not (Test-Path $ProjectRoot)) {
    throw "Project root does not exist: $ProjectRoot"
}

if ([string]::IsNullOrWhiteSpace($PythonExecutable)) {
    $PythonExecutable = (Resolve-OptionComboPython -ProjectRoot $ProjectRoot).Path
}

$stdoutPath = Join-Path $ProjectRoot $StdoutLogName
$stderrPath = Join-Path $ProjectRoot $StderrLogName
$pidPath = Join-Path $ProjectRoot $PidFileName

if ($StopExistingProcess -and (Test-Path $pidPath)) {
    try {
        $existingPidRaw = (Get-Content $pidPath -ErrorAction Stop | Select-Object -First 1).Trim()
        if ($existingPidRaw) {
            $existingPid = [int]$existingPidRaw
            $existingProcess = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
            if ($existingProcess) {
                Write-Host "Stopping existing ib_server.py process $existingPid..."
                Stop-Process -Id $existingPid -Force
                Start-Sleep -Seconds 1
            }
        }
    } catch {
        Write-Warning "Unable to stop existing process from pid file $pidPath. Continuing startup."
    }
}

$proc = Start-Process `
    -FilePath $PythonExecutable `
    -ArgumentList 'ib_server.py' `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

Set-Content -Path $pidPath -Value $proc.Id

Start-Sleep -Seconds 4

$runningProcess = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if (-not $runningProcess) {
    throw "ib_server.py exited during startup. Check $stderrPath"
}

[pscustomobject]@{
    ProjectRoot = $ProjectRoot
    Python = $PythonExecutable
    ProcessId = $proc.Id
    PidFile = $pidPath
    StdoutLog = $stdoutPath
    StderrLog = $stderrPath
}
