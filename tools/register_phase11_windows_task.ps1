param(
    [Parameter(Mandatory = $true)][string]$BatchRoot,
    [Parameter(Mandatory = $true)][string]$LinuxUser,
    [string]$Distro = 'Ubuntu',
    [string]$TaskName = 'Tobus Phase11 Aggregation',
    [switch]$Maintenance
)
$ErrorActionPreference = 'Stop'
if ($Maintenance -and !$PSBoundParameters.ContainsKey('TaskName')) { $TaskName = 'Tobus Phase11 History Maintenance' }
if ((Get-TimeZone).Id -ne 'Tokyo Standard Time') {
    throw 'This installer requires the Windows Asia/Tokyo time zone.'
}
if ($BatchRoot -notmatch '^/[A-Za-z0-9_./-]+$' -or $LinuxUser -notmatch '^[a-z_][a-z0-9_-]*$' -or $Distro -notmatch '^[A-Za-z0-9_.-]+$') {
    throw 'Unsupported path, Linux user, or distribution name.'
}
$backupDir = Join-Path $env:LOCALAPPDATA 'Tobus'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath (Join-Path $backupDir ('aggregation-task-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.xml')) -Encoding Unicode
}
$runner = if ($Maintenance) { 'run_phase11_history_maintenance.sh' } else { 'run_phase11_scheduled.sh' }
$arguments = "-d $Distro -u $LinuxUser --exec /bin/bash $BatchRoot/app/tools/$runner $BatchRoot"
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wsl.exe" -Argument $arguments
$at = if ($Maintenance) { '04:40' } else { '04:15' }
$trigger = New-ScheduledTaskTrigger -Daily -At $at
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2) -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
# Uses the distro owner's interactive logon; screen lock is OK, signing out is not.
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$description = if ($Maintenance) { '04:40 JST: bounded history backfill and legacy D1 read-only JSON export; shared aggregation lock.' } else { '04:15 JST: foreground WSL Phase 11 JSON aggregation and history archive; no D1 writes.' }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description -Force
