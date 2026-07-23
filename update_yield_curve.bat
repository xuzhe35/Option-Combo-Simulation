@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0powershell_scripts\update_yield_curve.ps1" %*
set "UPDATE_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%OPTION_COMBO_NO_PAUSE%"=="1" pause

endlocal & exit /b %UPDATE_EXIT_CODE%
