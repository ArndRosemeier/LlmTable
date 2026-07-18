@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
  echo npm was not found on PATH. Install Node.js and try again.
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    exit /b 1
  )
)

call :free_port 8787
call :free_port 5173

echo Starting LlmTable server on http://localhost:8787
start "LlmTable Server" cmd /k npm run dev:server

echo Starting LlmTable web on http://localhost:5173
start "LlmTable Web" cmd /k npm run dev:web

echo.
echo Both windows opened. Open http://localhost:5173 in your browser.
echo Close those windows to stop the app.
endlocal
exit /b 0

:free_port
set "PORT=%~1"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  echo Port %PORT% is in use by PID %%P — stopping it...
  taskkill /F /PID %%P >nul 2>&1
)
exit /b 0
