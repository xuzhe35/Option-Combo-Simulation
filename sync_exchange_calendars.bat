@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0powershell_scripts\sync_exchange_calendars.ps1" %*
exit /b %ERRORLEVEL%
