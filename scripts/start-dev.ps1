# Clean restart of the LlmTable Vite app (client-only; no API server).
$ErrorActionPreference = "Stop"

$rootPath = if ($env:LLM_TABLE_ROOT) { $env:LLM_TABLE_ROOT } else { Split-Path -Parent $PSScriptRoot }
Set-Location $rootPath
$env:LLM_TABLE_ROOT = $rootPath

$webUrl = "http://127.0.0.1:5173/"
$webWaitSeconds = 60

function Test-HttpOk([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Wait-WebReady([int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpOk $webUrl) {
      Write-Host ("  Web is up ({0})" -f $webUrl)
      return $true
    }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "ERROR: npm was not found on PATH. Install Node.js and try again."
  exit 1
}

if (-not (Test-Path (Join-Path $rootPath "node_modules"))) {
  Write-Host "Installing dependencies..."
  npm install
  if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: npm install failed."
    exit 1
  }
}

& (Join-Path $PSScriptRoot "stop-dev.ps1")
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Write-Host "Starting LlmTable on http://localhost:5173"
$command = 'start "LlmTable Web" cmd /k "npm run dev"'
& cmd.exe /c $command

Write-Host "Waiting for web..."
if (-not (Wait-WebReady $webWaitSeconds)) {
  Write-Host ("ERROR: web did not become ready at {0} within {1}s." -f $webUrl, $webWaitSeconds)
  Write-Host "Check the LlmTable Web window for errors, then run start.bat again."
  exit 1
}

Write-Host ""
Write-Host "LlmTable is ready. Open http://localhost:5173/ in your browser."
Write-Host "Close the Web window to stop, or run start.bat again to restart cleanly."
exit 0
