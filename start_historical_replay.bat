@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0powershell_scripts\start_historical_replay.ps1"

endlocal
