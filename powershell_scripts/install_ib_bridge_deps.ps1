$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$requirementsPath = Join-Path $projectRoot 'requirements-ib-bridge.txt'
$python = & (Join-Path $PSScriptRoot 'resolve_python.ps1') -ProjectRoot $projectRoot

if (-not (Test-Path $requirementsPath)) {
    throw "Missing requirements file: $requirementsPath"
}

try {
    & $python -m pip --version | Out-Null
} catch {
    Write-Host "pip not found for $python. Trying ensurepip..."
    & $python -m ensurepip --upgrade
}

$inVirtualEnv = ((& $python -c "import sys; print('1' if sys.prefix != sys.base_prefix else '0')").Trim() -eq '1')
$arguments = @('-m', 'pip', 'install', '--upgrade')

if (-not $inVirtualEnv) {
    $arguments += '--user'
}

$arguments += @('-r', $requirementsPath)

Write-Host "Using Python: $python"
Write-Host "Installing IB bridge dependencies from $requirementsPath"

& $python @arguments

Write-Host ''
Write-Host 'Installed:'
Write-Host '  - ib_async'
Write-Host '  - websockets'
