$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'python_launcher_common.ps1')

$projectRoot = Split-Path -Parent $PSScriptRoot
$python = (Resolve-OptionComboPython -ProjectRoot $projectRoot).Path
$workdir = $projectRoot

$services = @(
    @{
        Name = 'HTTP Server'
        Arguments = @('-m', 'http.server', '8000')
        Stdout = 'http_server.codex.log'
        Stderr = 'http_server.codex.err.log'
        Pid = 'http_server.codex.pid'
    },
    @{
        Name = 'IB Server'
        Arguments = @('ib_server.py')
        Stdout = 'ib_server.codex.log'
        Stderr = 'ib_server.codex.err.log'
        Pid = 'ib_server.codex.pid'
    }
)

$results = foreach ($service in $services) {
    $stdout = Join-Path $workdir $service.Stdout
    $stderr = Join-Path $workdir $service.Stderr
    $pidFile = Join-Path $workdir $service.Pid

    $proc = Start-Process -FilePath $python `
        -ArgumentList $service.Arguments `
        -WorkingDirectory $workdir `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru

    Set-Content -Path $pidFile -Value $proc.Id

    [pscustomobject]@{
        Name = $service.Name
        Id = $proc.Id
        Log = $stdout
        ErrorLog = $stderr
        Path = $python
    }
}

Start-Sleep -Seconds 2

foreach ($result in $results) {
    if (-not (Get-Process -Id $result.Id -ErrorAction SilentlyContinue)) {
        throw "$($result.Name) exited during startup. Check $($result.ErrorLog)."
    }
}

$results
