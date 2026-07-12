param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$NyseOnly,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'python_launcher_common.ps1')

$python = Resolve-OptionComboPython -ProjectRoot $ProjectRoot
$script = Join-Path $ProjectRoot 'scripts\sync_official_exchange_calendars.py'
$arguments = @($script)
if ($NyseOnly) { $arguments += '--nyse-only' }
if ($Check) { $arguments += '--check' }

& $python.Path @arguments
exit $LASTEXITCODE
