$projectRoot = Split-Path -Parent $PSScriptRoot
$workdir = $projectRoot
$runtimeDir = Join-Path $workdir 'logs'
$pidFiles = @(
    (Join-Path $runtimeDir 'ib_server.codex.pid'),
    (Join-Path $workdir 'ib_server.codex.pid')
)

foreach ($pidFile in $pidFiles) {
    if (Test-Path $pidFile) {
        try {
            $serverPid = [int](Get-Content $pidFile)
            Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        } catch {
        }
    }
}

& (Join-Path $PSScriptRoot 'launch_ib_server_codex.ps1')
