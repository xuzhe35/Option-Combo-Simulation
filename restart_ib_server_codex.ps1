$workdir = 'C:\Users\xuzhe\OneDrive\projects\Option Combo Simulation'
$pidFile = Join-Path $workdir 'ib_server.codex.pid'

if (Test-Path $pidFile) {
    try {
        $serverPid = [int](Get-Content $pidFile)
        Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    } catch {
    }
}

& (Join-Path $workdir 'launch_ib_server_codex.ps1')
