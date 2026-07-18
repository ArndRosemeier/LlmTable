@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "LLM_TABLE_ROOT=%CD%"

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

echo Stopping any previous LlmTable processes...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-dev.ps1"
if errorlevel 1 (
  echo Warning: cleanup reported an error; continuing anyway.
)

echo Starting LlmTable server on http://localhost:8787
start "LlmTable Server" cmd /k npm run dev:server

echo Starting LlmTable web on http://localhost:5173
start "LlmTable Web" cmd /k npm run dev:web

echo.
echo Both windows opened. Open http://localhost:5173 in your browser.
echo Close those windows to stop the app, or run start.bat again to restart cleanly.
endlocal
exit /b 0
