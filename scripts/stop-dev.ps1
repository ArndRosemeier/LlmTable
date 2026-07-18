# Stops previous LlmTable dev processes and frees ports 8787 / 5173.
$ErrorActionPreference = "SilentlyContinue"

$rootPath = if ($env:LLM_TABLE_ROOT) { $env:LLM_TABLE_ROOT } else { Split-Path -Parent $PSScriptRoot }
$root = [regex]::Escape($rootPath)
$killed = New-Object "System.Collections.Generic.HashSet[int]"

function Stop-TrackedPid([int]$ProcId, [string]$Reason) {
  if ($ProcId -le 0 -or -not $killed.Add($ProcId)) {
    return
  }
  Write-Host ("  stopping PID {0} ({1})" -f $ProcId, $Reason)
  Stop-Process -Id $ProcId -Force
}

Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" | ForEach-Object {
  if ($_.CommandLine -match "LlmTable (Server|Web)") {
    Stop-TrackedPid $_.ProcessId "LlmTable console"
  }
}

Get-Process | Where-Object { $_.MainWindowTitle -match "^LlmTable (Server|Web)$" } | ForEach-Object {
  Stop-TrackedPid $_.Id "window title"
}

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | ForEach-Object {
  $cmd = $_.CommandLine
  if (-not $cmd) {
    return
  }
  $inRepo = $cmd -match $root
  $isDev = $cmd -match "dev:server|dev:web|tsx watch|vite"
  if ($inRepo -and $isDev) {
    Stop-TrackedPid $_.ProcessId "node/tsx/vite"
  }
}

foreach ($port in 8787, 5173) {
  Get-NetTCPConnection -LocalPort $port -State Listen | ForEach-Object {
    Stop-TrackedPid $_.OwningProcess ("port $port")
  }
}

Start-Sleep -Milliseconds 800

foreach ($port in 8787, 5173) {
  $left = @(Get-NetTCPConnection -LocalPort $port -State Listen)
  if ($left.Count -gt 0) {
    $pids = ($left.OwningProcess | Select-Object -Unique) -join ", "
    Write-Host ("WARNING: port {0} still in use by PID(s) {1}" -f $port, $pids)
  }
}

if ($killed.Count -eq 0) {
  Write-Host "  nothing to stop"
} else {
  Write-Host ("  stopped {0} process(es)" -f $killed.Count)
}
