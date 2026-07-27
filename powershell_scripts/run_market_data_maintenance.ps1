param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$YieldIfNeeded,
    [switch]$NyseOnly
)

$ErrorActionPreference = 'Stop'

function Invoke-MaintenanceScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,

        [string[]]$Arguments = @()
    )

    $previousNoPause = $env:OPTION_COMBO_NO_PAUSE
    try {
        $env:OPTION_COMBO_NO_PAUSE = '1'
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments
        return $LASTEXITCODE
    } finally {
        if ($null -eq $previousNoPause) {
            Remove-Item Env:OPTION_COMBO_NO_PAUSE -ErrorAction SilentlyContinue
        } else {
            $env:OPTION_COMBO_NO_PAUSE = $previousNoPause
        }
    }
}

Set-Location $ProjectRoot
Write-Host 'Option Combo Simulation - market-data maintenance'
Write-Host ''

$yieldArguments = @('-ProjectRoot', $ProjectRoot)
if ($YieldIfNeeded) {
    $yieldArguments += '-IfNeeded'
}

Write-Host '[1/2] Updating the USD yield curve...'
$yieldExitCode = Invoke-MaintenanceScript `
    -ScriptPath (Join-Path $PSScriptRoot 'update_yield_curve.ps1') `
    -Arguments $yieldArguments
if ($yieldExitCode -ne 0) {
    Write-Host ''
    Write-Host "Yield-curve maintenance failed (exit $yieldExitCode)." -ForegroundColor Red
    Write-Host 'Exchange-calendar maintenance was not started.'
    exit $yieldExitCode
}

$calendarArguments = @('-ProjectRoot', $ProjectRoot)
if ($NyseOnly) {
    $calendarArguments += '-NyseOnly'
} else {
    $calendarArguments += '-AutoScope'
}

Write-Host ''
Write-Host '[2/2] Updating official exchange calendars...'
$calendarExitCode = Invoke-MaintenanceScript `
    -ScriptPath (Join-Path $PSScriptRoot 'sync_exchange_calendars.ps1') `
    -Arguments $calendarArguments
if ($calendarExitCode -ne 0) {
    Write-Host ''
    Write-Host "Exchange-calendar maintenance failed (exit $calendarExitCode)." -ForegroundColor Red
    exit $calendarExitCode
}

Write-Host ''
Write-Host 'All market-data maintenance completed successfully.' -ForegroundColor Green
exit 0
