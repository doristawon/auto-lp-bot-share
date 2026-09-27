$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$envFile = Join-Path $repoRoot '.env'
$info = Get-Item -LiteralPath $envFile -ErrorAction Stop
if ($info.PSIsContainer -or ($info.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
  throw '本機 .env 不是一般檔案。'
}
$line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^DASHBOARD_TOKEN=' } | Select-Object -First 1
if (-not $line) { throw '本機 .env 尚未設定 DASHBOARD_TOKEN。' }
$token = ($line -split '=', 2)[1].Trim()
if ($token.Length -lt 32) { throw 'DASHBOARD_TOKEN 長度不足。' }
Set-Clipboard -Value $token
Write-Output '已將中控台權杖複製到剪貼簿，請貼入本機中控台的解鎖欄位。'
