$ErrorActionPreference = "Stop"

$distro = "Ubuntu"
$wsl = "$env:WINDIR\System32\wsl.exe"
$logDirectory = Join-Path $env:LOCALAPPDATA "Tobus"
$logPath = Join-Path $logDirectory "refresh-wsl.log"
$aggregationLock = "/home/yachiyo/tobus-phase11-batch/aggregation.lock"

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

function Write-RefreshLog([string]$message) {
  Add-Content -Path $logPath -Value "$(Get-Date -Format o) $message"
}

try {
  & $wsl -d $distro -u root --exec /bin/bash -lc "ps -eo tty= | grep -qE '^[[:space:]]*pts/'"
  if ($LASTEXITCODE -eq 0) {
    Write-RefreshLog "skipped: interactive WSL terminal is open"
    exit 0
  }

  & $wsl -d $distro -u root --exec /usr/bin/flock -n $aggregationLock -c /bin/true
  if ($LASTEXITCODE -ne 0) {
    Write-RefreshLog "skipped: Phase 11 aggregation is running"
    exit 0
  }

  Write-RefreshLog "starting WSL refresh"
  & $wsl --shutdown
  Start-Sleep -Seconds 15
  & $wsl -d $distro -u root --exec /usr/bin/systemctl start cron
  if ($LASTEXITCODE -ne 0) {
    throw "cron startup returned exit code $LASTEXITCODE"
  }
  Write-RefreshLog "completed WSL refresh"
  exit 0
} catch {
  Write-RefreshLog "failed: $($_.Exception.Message)"
  exit 1
}
