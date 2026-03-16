@echo off
setlocal

cd /d "%~dp0"

start "Option Combo HTTP Server" cmd /k "cd /d ""%~dp0"" && python -m http.server 8000"
start "Option Combo IB Server" cmd /k "cd /d ""%~dp0"" && python ib_server.py"

echo Started:
echo   - Frontend: http://localhost:8000/index.html
echo   - IB bridge: ws://localhost:8765

endlocal
