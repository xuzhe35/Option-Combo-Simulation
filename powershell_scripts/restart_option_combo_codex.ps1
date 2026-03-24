$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$workdir = $projectRoot
$pidFiles = @(
    (Join-Path $workdir 'http_server.codex.pid'),
    (Join-Path $workdir 'ib_server.codex.pid')
)

foreach ($pidFile in $pidFiles) {
    if (-not (Test-Path $pidFile)) {
        continue
    }

    try {
        $pid = [int](Get-Content $pidFile)
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    } catch {
    }
}

& (Join-Path $PSScriptRoot 'start_option_combo_codex.ps1')
