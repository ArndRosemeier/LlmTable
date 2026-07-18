@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "LLM_TABLE_ROOT=%CD%"

echo LlmTable (browser-only — no API server)
echo.

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm was not found on PATH. Install Node.js and try again.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-dev.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo start.bat failed with exit code %EXIT_CODE%.
  pause
  exit /b %EXIT_CODE%
)

endlocal
exit /b 0
