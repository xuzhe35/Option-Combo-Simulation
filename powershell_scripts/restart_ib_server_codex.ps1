$projectRoot = Split-Path -Parent $PSScriptRoot
$workdir = $projectRoot
$pidFile = Join-Path $workdir 'ib_server.codex.pid'

if (Test-Path $pidFile) {
    try {
        $serverPid = [int](Get-Content $pidFile)
        Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    } catch {
    }
}

& (Join-Path $PSScriptRoot 'launch_ib_server_codex.ps1')
