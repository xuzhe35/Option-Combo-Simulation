@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0powershell_scripts\sync_exchange_calendars.ps1" %*
set "SYNC_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%OPTION_COMBO_NO_PAUSE%"=="1" pause

endlocal & exit /b %SYNC_EXIT_CODE%
