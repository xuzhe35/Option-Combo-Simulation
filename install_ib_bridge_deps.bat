@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0powershell_scripts\install_ib_bridge_deps.ps1"

endlocal
