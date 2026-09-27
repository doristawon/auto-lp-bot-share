$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entrypoint = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'src\index.js'))
$logsDir = Join-Path $repoRoot 'logs'
$stateDir = Join-Path $repoRoot 'state'
$supervisorLog = Join-Path $logsDir 'dashboard-supervisor.log'
$stopFile = Join-Path $stateDir 'dashboard-supervisor.stop'
$dashboardPort = 8787
$dashboardToken = ''
$envFile = Join-Path $repoRoot '.env'

New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

if (Test-Path -LiteralPath $envFile) {
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*DASHBOARD_PORT\s*=\s*(\d+)') {
      $dashboardPort = [int]$Matches[1]
    }
    if ($line -match '^\s*DASHBOARD_TOKEN\s*=\s*(.*)$') {
      $dashboardToken = $Matches[1].Trim().Trim('"').Trim("'")
    }
  }
}

if ($dashboardPort -lt 1 -or $dashboardPort -gt 65535) {
  throw 'DASHBOARD_PORT in .env must be between 1 and 65535.'
}

$script:repoRoot = $repoRoot
$script:entrypoint = $entrypoint
$script:logsDir = $logsDir
$script:dashboardToken = $dashboardToken
$script:healthUri = "http://127.0.0.1:$dashboardPort/api/health"
$script:nodeExe = (Get-Command node.exe -ErrorAction Stop).Source

function Write-SupervisorLog {
  param(
    [Parameter(Mandatory = $true)][string]$Event,
    [hashtable]$Data = @{}
  )

  $record = [ordered]@{
    ts = [DateTime]::UtcNow.ToString('o')
    event = $Event
  }
  foreach ($key in $Data.Keys) { $record[$key] = $Data[$key] }
  Add-Content -LiteralPath $supervisorLog -Value ($record | ConvertTo-Json -Compress -Depth 4) -Encoding UTF8
}

function Get-AppProcess {
  $processRows = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($script:entrypoint, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
  foreach ($procInfo in $processRows) {
    $process = Get-Process -Id $procInfo.ProcessId -ErrorAction SilentlyContinue
    if ($process) { return $process }
  }
  return $null
}

function Test-DashboardHealth {
  try {
    $headers = @{}
    if ($script:dashboardToken) { $headers['x-dashboard-token'] = $script:dashboardToken }
    $response = Invoke-RestMethod -Uri $script:healthUri -Method Get -Headers $headers -TimeoutSec 5 -ErrorAction Stop
    return ($null -ne $response)
  } catch {
    return $false
  }
}

function Start-AppProcess {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $stdoutPath = Join-Path $script:logsDir "auto-lp-supervised-$stamp.stdout.log"
  $stderrPath = Join-Path $script:logsDir "auto-lp-supervised-$stamp.stderr.log"
  $entrypointArgument = '"{0}"' -f $script:entrypoint
  $process = Start-Process -FilePath $script:nodeExe `
    -ArgumentList $entrypointArgument `
    -WorkingDirectory $script:repoRoot `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath
  Write-SupervisorLog -Event 'app.started' -Data @{ processId = $process.Id; stdout = [System.IO.Path]::GetFileName($stdoutPath); stderr = [System.IO.Path]::GetFileName($stderrPath) }
  return $process
}

Write-SupervisorLog -Event 'supervisor.started' -Data @{ processId = $PID; port = $dashboardPort }
$child = $null
$healthFailures = 0
$externalHealthy = $false

while ($true) {
  if (Test-Path -LiteralPath $stopFile) {
    if ($child) {
      Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
      Write-SupervisorLog -Event 'app.stopped' -Data @{ processId = $child.Id; reason = 'stop-file' }
    }
    Write-SupervisorLog -Event 'supervisor.stopped' -Data @{ reason = 'stop-file' }
    break
  }

  if (-not $child) {
    $existing = Get-AppProcess
    if ($existing) {
      $child = $existing
      Write-SupervisorLog -Event 'app.attached' -Data @{ processId = $child.Id }
    } elseif (Test-DashboardHealth) {
      if (-not $externalHealthy) {
        Write-SupervisorLog -Event 'dashboard.already_healthy' -Data @{ port = $dashboardPort }
        $externalHealthy = $true
      }
      Start-Sleep -Seconds 15
      continue
    } else {
      $externalHealthy = $false
      try {
        $child = Start-AppProcess
      } catch {
        Write-SupervisorLog -Event 'app.launch_failed' -Data @{ errorType = $_.Exception.GetType().Name }
        Start-Sleep -Seconds 10
        continue
      }
    }
  }

  Start-Sleep -Seconds 15
  if (Test-Path -LiteralPath $stopFile) { continue }

  $child.Refresh()
  if ($child.HasExited) {
    Write-SupervisorLog -Event 'app.exited' -Data @{ processId = $child.Id; exitCode = $child.ExitCode }
    $child = $null
    $healthFailures = 0
    Start-Sleep -Seconds 3
    continue
  }

  if (Test-DashboardHealth) {
    if ($healthFailures -gt 0) {
      Write-SupervisorLog -Event 'dashboard.health_recovered' -Data @{ processId = $child.Id }
    }
    $healthFailures = 0
  } else {
    $healthFailures++
    if ($healthFailures -ge 4) {
      Write-SupervisorLog -Event 'dashboard.health_failed_restarting_app' -Data @{ processId = $child.Id; consecutiveFailures = $healthFailures }
      Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
      $child = $null
      $healthFailures = 0
    }
  }
}
