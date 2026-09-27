$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$supervisorScript = Join-Path $PSScriptRoot 'supervise-dashboard.ps1'
$taskName = 'AutoLPBotDashboard'
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$powerShellExe = (Get-Command powershell.exe -ErrorAction Stop).Source

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  $scriptPathInAction = $existing.Actions | Where-Object { $_.Arguments -and $_.Arguments.Contains($supervisorScript) }
  if (-not $scriptPathInAction) {
    throw "Scheduled task '$taskName' already exists with a different action; it was left unchanged."
  }
}

$arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $supervisorScript
$action = New-ScheduledTaskAction -Execute $powerShellExe -Argument $arguments -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 10 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description 'Keeps the local auto_LP_bot dashboard supervised and restarts it after an unhealthy API or process exit.' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Output "Installed and started $taskName for $currentUser."
