@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0powershell_scripts\run_market_data_maintenance.ps1" %*
set "MAINTENANCE_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%OPTION_COMBO_NO_PAUSE%"=="1" pause

endlocal & exit /b %MAINTENANCE_EXIT_CODE%
