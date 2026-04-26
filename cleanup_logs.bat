@echo off
setlocal

cd /d "%~dp0"

for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0powershell_scripts\resolve_python.ps1"`) do set "PYTHON=%%P"

if not defined PYTHON (
    echo Unable to resolve Python.
    exit /b 1
)

"%PYTHON%" "%~dp0scripts\cleanup_runtime_logs.py" %*

endlocal
