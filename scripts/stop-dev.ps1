# Stops previous LlmTable Vite processes and frees ports 5173-5180.
$ErrorActionPreference = "SilentlyContinue"

$rootPath = if ($env:LLM_TABLE_ROOT) { $env:LLM_TABLE_ROOT } else { Split-Path -Parent $PSScriptRoot }
$rootRegex = [regex]::Escape($rootPath)
$rootAlt = [regex]::Escape(($rootPath -replace '\\', '/'))
$killed = New-Object "System.Collections.Generic.HashSet[int]"
$vitePorts = 5173..5180

function Test-InRepo([string]$CommandLine) {
  if (-not $CommandLine) {
    return $false
  }
  return ($CommandLine -match $rootRegex) -or ($CommandLine -match $rootAlt)
}

function Stop-ProcessTree([int]$ProcId, [string]$Reason) {
  if ($ProcId -le 0 -or -not $killed.Add($ProcId)) {
    return
  }
  Write-Host ("  stopping PID {0} ({1})" -f $ProcId, $Reason)
  & taskkill.exe /PID $ProcId /T /F 2>$null | Out-Null
}

function Get-Listeners([int[]]$Ports) {
  foreach ($port in $Ports) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      ForEach-Object { [pscustomobject]@{ Port = $port; Pid = [int]$_.OwningProcess } }
  }
}

function Test-IsLlmTableDevProcess([string]$Name, [string]$CommandLine) {
  if (-not $CommandLine) {
    return $false
  }

  if ($Name -eq "cmd.exe" -and $CommandLine -match "npm run (dev|dev:web)|LlmTable Web|title LlmTable") {
    return $true
  }

  if ($Name -eq "node.exe" -and $CommandLine -match "npm-cli\.js.*run (dev|dev:web)") {
    return $true
  }

  if ((Test-InRepo $CommandLine) -and ($CommandLine -match "dev:web|vite\.js|vite\\bin|vite/bin|@llm-table/web")) {
    return $true
  }

  return $false
}

function Stop-LlmTableDevProcesses {
  Get-CimInstance Win32_Process | ForEach-Object {
    if (Test-IsLlmTableDevProcess $_.Name $_.CommandLine) {
      Stop-ProcessTree ([int]$_.ProcessId) $_.Name
    }
  }

  Get-Process | Where-Object { $_.MainWindowTitle -match "^LlmTable Web$" } | ForEach-Object {
    Stop-ProcessTree $_.Id "window title"
  }

  foreach ($listener in Get-Listeners $vitePorts) {
    Stop-ProcessTree $listener.Pid ("port {0}" -f $listener.Port)
  }
}

Write-Host "Stopping any previous LlmTable processes..."

$portsFree = $false
for ($attempt = 1; $attempt -le 10; $attempt++) {
  Stop-LlmTableDevProcesses
  Start-Sleep -Milliseconds (500 + 150 * $attempt)

  $left = @(Get-Listeners $vitePorts | Where-Object { $_.Pid -gt 0 })
  $stragglers = @(
    Get-CimInstance Win32_Process |
      Where-Object { Test-IsLlmTableDevProcess $_.Name $_.CommandLine }
  )

  if ($left.Count -eq 0 -and $stragglers.Count -eq 0) {
    $portsFree = $true
    break
  }

  if ($left.Count -gt 0) {
    $summary = ($left | ForEach-Object { "{0}:{1}" -f $_.Port, $_.Pid } | Select-Object -Unique) -join ", "
    Write-Host ("  ports still busy (attempt {0}/10): {1}" -f $attempt, $summary)
    foreach ($listener in $left) {
      Stop-ProcessTree $listener.Pid ("retry port {0}" -f $listener.Port)
    }
  }

  foreach ($proc in $stragglers) {
    Stop-ProcessTree ([int]$proc.ProcessId) ("retry {0}" -f $proc.Name)
  }
}

if ($killed.Count -eq 0) {
  Write-Host "  nothing to stop"
} else {
  Write-Host ("  stopped {0} process tree(s)" -f $killed.Count)
}

if (-not $portsFree) {
  $left = @(Get-Listeners $vitePorts)
  $summary = ($left | ForEach-Object { "{0}:{1}" -f $_.Port, $_.Pid } | Select-Object -Unique) -join ", "
  Write-Host ("ERROR: could not free Vite ports ({0}). Close those processes and retry." -f $summary)
  exit 1
}

Write-Host ("  ports {0}-{1} are free" -f $vitePorts[0], $vitePorts[-1])
exit 0
