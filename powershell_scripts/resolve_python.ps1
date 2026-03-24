param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$Detailed
)

. (Join-Path $PSScriptRoot 'python_launcher_common.ps1')

$python = Resolve-OptionComboPython -ProjectRoot $ProjectRoot

if ($Detailed) {
    $python
} else {
    $python.Path
}
