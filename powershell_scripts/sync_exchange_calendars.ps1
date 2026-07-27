param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$NyseOnly,
    [switch]$AutoScope,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'python_launcher_common.ps1')

# Load CME OAuth credentials for the full sync from config.local.ini [cme]
# without overriding anything the caller already set in the environment.
$localConfig = Join-Path $ProjectRoot 'config.local.ini'
foreach ($pair in @(
        @{ Env = 'CME_API_ID';       Key = 'api_id' },
        @{ Env = 'CME_API_SECRET';   Key = 'api_secret' },
        @{ Env = 'CME_ACCESS_TOKEN'; Key = 'access_token' })) {
    if (-not [Environment]::GetEnvironmentVariable($pair.Env)) {
        $value = Get-IniValue -Path $localConfig -Section 'cme' -Key $pair.Key
        if ($value) { Set-Item -Path "Env:$($pair.Env)" -Value $value }
    }
}

if ($AutoScope -and -not ($NyseOnly -or $Check) -and -not $env:CME_API_ID -and -not $env:CME_ACCESS_TOKEN) {
    $NyseOnly = $true
    Write-Warning 'No CME credentials were found; automatically refreshing NYSE only.'
    Write-Warning 'Existing CME/NYMEX/COMEX entries will be preserved with their original timestamps.'
}

if (-not ($NyseOnly -or $Check) -and -not $env:CME_API_ID -and -not $env:CME_ACCESS_TOKEN) {
    Write-Warning 'No CME credentials found (config.local.ini [cme] or CME_API_ID/SECRET env).'
    Write-Warning 'The full sync needs them: copy config.local.ini.example -> config.local.ini and fill [cme], or pass -NyseOnly.'
}

$python = Resolve-OptionComboPython -ProjectRoot $ProjectRoot
$script = Join-Path $ProjectRoot 'scripts\sync_official_exchange_calendars.py'
$arguments = @($script)
if ($NyseOnly) { $arguments += '--nyse-only' }
if ($Check) { $arguments += '--check' }

Write-Host 'Option Combo Simulation - official exchange-calendar updater'
Write-Host "Python: $($python.Path)"
Write-Host ''
Write-Host 'Downloading and validating official NYSE/CME exchange calendars...'
& $python.Path @arguments
$syncExitCode = $LASTEXITCODE

Write-Host ''
if ($syncExitCode -eq 0) {
    if ($Check) {
        Write-Host 'Exchange-calendar validation completed successfully.' -ForegroundColor Green
    } else {
        Write-Host 'Exchange-calendar maintenance completed successfully.' -ForegroundColor Green
        Write-Host 'Hard-refresh open browser pages before relying on the new calendar snapshot.'
    }
    exit 0
}

Write-Host "Exchange-calendar update failed (exit $syncExitCode)." -ForegroundColor Red
Write-Host 'Existing generated calendar files were left unchanged.'
exit $syncExitCode
