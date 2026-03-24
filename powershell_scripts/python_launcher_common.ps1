$ErrorActionPreference = 'Stop'

function Get-IniValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Section,

        [Parameter(Mandatory = $true)]
        [string]$Key
    )

    if (-not (Test-Path $Path)) {
        return $null
    }

    $currentSection = ''
    foreach ($line in Get-Content $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed) {
            continue
        }
        if ($trimmed.StartsWith(';') -or $trimmed.StartsWith('#')) {
            continue
        }
        if ($trimmed -match '^\[(.+)\]$') {
            $currentSection = $Matches[1].Trim()
            continue
        }
        if ($currentSection -ne $Section) {
            continue
        }
        if ($trimmed -match '^(?<name>[^=]+)=(?<value>.*)$') {
            if ($Matches['name'].Trim() -eq $Key) {
                return $Matches['value'].Trim()
            }
        }
    }

    return $null
}

function Get-ConfiguredPythonCandidate {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigPath,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    $configuredPython = Get-IniValue -Path $ConfigPath -Section 'python' -Key 'executable'
    if (-not $configuredPython) {
        return $null
    }

    return @{
        Source = $Label
        Path = $configuredPython
    }
}

function Get-CommonPythonInstallCandidates {
    $candidates = @()
    $programFilesX86 = [System.Environment]::GetEnvironmentVariable('ProgramFiles(x86)', 'Process')
    $versions = @('Python314', 'Python313', 'Python312', 'Python311', 'Python310', 'Python39', 'Python38')
    $locations = @()

    if ($env:LOCALAPPDATA) {
        foreach ($version in $versions) {
            $locations += @{
                Source = 'LOCALAPPDATA Programs\Python'
                Path = (Join-Path $env:LOCALAPPDATA "Programs\Python\$version\python.exe")
            }
        }
    }

    if ($env:ProgramFiles) {
        foreach ($version in $versions) {
            $locations += @{
                Source = 'Program Files'
                Path = (Join-Path $env:ProgramFiles "$version\python.exe")
            }
        }
    }

    if ($programFilesX86) {
        foreach ($version in $versions) {
            $locations += @{
                Source = 'Program Files (x86)'
                Path = (Join-Path $programFilesX86 "$version\python.exe")
            }
        }
    }

    foreach ($location in $locations) {
        if (Test-Path $location.Path) {
            $candidates += $location
        }
    }

    return $candidates
}

function Resolve-OptionComboPython {
    param(
        [string]$ProjectRoot = $PSScriptRoot
    )

    $configPath = Join-Path $ProjectRoot 'config.ini'
    $localConfigPath = Join-Path $ProjectRoot 'config.local.ini'
    $directCandidates = @()
    $commandCandidates = @()

    if ($env:OPTION_COMBO_PYTHON) {
        $directCandidates += @{
            Source = 'OPTION_COMBO_PYTHON'
            Path = $env:OPTION_COMBO_PYTHON
        }
    }

    $localConfigCandidate = Get-ConfiguredPythonCandidate -ConfigPath $localConfigPath -Label 'config.local.ini [python].executable'
    if ($localConfigCandidate) {
        $directCandidates += $localConfigCandidate
    }

    $sharedConfigCandidate = Get-ConfiguredPythonCandidate -ConfigPath $configPath -Label 'config.ini [python].executable'
    if ($sharedConfigCandidate) {
        $directCandidates += $sharedConfigCandidate
    }

    $directCandidates += @(
        @{
            Source = '.venv'
            Path = (Join-Path $ProjectRoot '.venv\Scripts\python.exe')
        },
        @{
            Source = 'venv'
            Path = (Join-Path $ProjectRoot 'venv\Scripts\python.exe')
        }
    )

    $directCandidates += Get-CommonPythonInstallCandidates

    $commandCandidates += @(
        @{
            Source = 'PATH python.exe'
            Path = $null
            Command = 'python.exe'
        },
        @{
            Source = 'PATH python'
            Path = $null
            Command = 'python'
        }
    )

    $candidates = @($directCandidates + $commandCandidates)
    foreach ($candidate in $candidates) {
        if ($candidate.Path) {
            if (Test-Path $candidate.Path) {
                return [pscustomobject]@{
                    Source = $candidate.Source
                    Path = (Resolve-Path $candidate.Path).ProviderPath
                }
            }
            continue
        }

        if (-not $candidate.Command) {
            continue
        }

        try {
            $command = Get-Command $candidate.Command -ErrorAction Stop
            if ($command.CommandType -eq 'Application' -and $command.Source) {
                return [pscustomobject]@{
                    Source = $candidate.Source
                    Path = $command.Source
                }
            }
        } catch {
        }
    }

    throw "Unable to resolve a Python executable. Set OPTION_COMBO_PYTHON, create config.local.ini [python].executable, or install Python into PATH/.venv."
}
