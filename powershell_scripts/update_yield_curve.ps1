param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$IfNeeded,
    [switch]$StatusOnly,
    [string]$Date = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'python_launcher_common.ps1')

$python = Resolve-OptionComboPython -ProjectRoot $ProjectRoot
Set-Location $ProjectRoot

& $python.Path -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)"
if ($LASTEXITCODE -ne 0) {
    throw "Python 3.8 or newer is required for the yield-curve updater: $($python.Path)"
}

Write-Host 'Option Combo Simulation - USD yield-curve updater'
Write-Host "Python: $($python.Path)"
Write-Host ''

$updateExitCode = 0
if (-not $StatusOnly) {
    $updateArguments = @('-m', 'yield_curve', 'update')
    if ($IfNeeded) {
        $updateArguments += '--if-needed'
    }
    if ($Date) {
        $updateArguments += @('--date', $Date)
    }

    Write-Host 'Checking official NY Fed SOFR and U.S. Treasury CMT data...'
    & $python.Path @updateArguments
    $updateExitCode = $LASTEXITCODE
    Write-Host ''
    if ($updateExitCode -ne 0) {
        Write-Host "Yield-curve update failed (exit $updateExitCode)." -ForegroundColor Red
        Write-Host 'The updater never overwrites a prior complete snapshot with a failed download.'
        Write-Host ''
    }
}

Write-Host 'Current local snapshot:'
& $python.Path -m yield_curve status
$statusExitCode = $LASTEXITCODE

Write-Host ''
if ($updateExitCode -eq 0 -and $statusExitCode -eq 0) {
    Write-Host 'Yield-curve maintenance completed successfully.' -ForegroundColor Green
    exit 0
}
if ($statusExitCode -ne 0) {
    Write-Host 'No usable local yield-curve snapshot is available.' -ForegroundColor Red
}
if ($updateExitCode -ne 0) {
    exit $updateExitCode
}
exit $statusExitCode
