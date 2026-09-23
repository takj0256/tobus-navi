param(
  [Parameter(Mandatory=$true)][string]$BatchRoot,
  [Parameter(Mandatory=$true)][string]$LinuxUser,
  [string]$Distro = 'Ubuntu'
)
$ErrorActionPreference = 'Stop'
if ($BatchRoot -notmatch '^/[A-Za-z0-9_./-]+$' -or $LinuxUser -notmatch '^[a-z_][a-z0-9_-]*$' -or $Distro -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Unsupported arguments' }
$taskName = 'Tobus Phase11 Raw Processor'
$backupDir = Join-Path $env:LOCALAPPDATA 'Tobus'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath (Join-Path $backupDir ('raw-task-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.xml')) -Encoding Unicode
}
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wsl.exe" -Argument "-d $Distro -u $LinuxUser --exec /bin/bash $BatchRoot/app/tools/run_phase11_raw_processor.sh $BatchRoot"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2)
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1) -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Every 2 minutes: replay persisted raw GTFS on WSL, durable outbox, bounded D1 operations. Login required.' -Force
