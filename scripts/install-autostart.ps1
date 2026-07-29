<#
.SYNOPSIS
  Starts Claude Lifeline automatically when you log in.

.DESCRIPTION
  A note on "Windows service", since that is the usual first instinct: services
  run in session 0, which has no desktop. A service therefore cannot draw a tray
  icon or raise a notification toast. The supported way to get service-like
  behaviour with a UI is a Scheduled Task triggered at logon, which is what this
  installs.

  The task runs as the current user at their normal privilege level. It needs no
  elevation, because everything Lifeline touches lives under the user's profile.

  Recovery itself does not depend on this task at all: the hooks run inside
  Claude Code. Autostart is only for the tray icon and notifications.

.PARAMETER Uninstall
  Remove the scheduled task.

.PARAMETER TaskName
  Override the task name. Defaults to "Claude Lifeline".

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall
#>

[CmdletBinding()]
param(
  [switch]$Uninstall,
  [string]$TaskName = 'Claude Lifeline'
)

$ErrorActionPreference = 'Stop'

function Write-Ok    ($m) { Write-Host "OK   $m" -ForegroundColor Green }
function Write-Info  ($m) { Write-Host "     $m" -ForegroundColor DarkGray }
function Write-Warn2 ($m) { Write-Host "WARN $m" -ForegroundColor Yellow }

# ScheduledTasks cmdlets are present on Windows 8+/Server 2012+, so every
# supported Windows 11 build has them. Verified rather than assumed.
if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
  throw 'The ScheduledTasks module is unavailable. Install the task manually via Task Scheduler.'
}

if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $existing) {
    Write-Warn2 "No scheduled task named '$TaskName' was found. Nothing to remove."
    exit 0
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Ok "Removed the '$TaskName' logon task."
  Write-Info 'Your Claude Code sessions are still protected: the recovery hooks are independent of this task.'
  exit 0
}

$repoRoot = Split-Path -Parent $PSScriptRoot

# Prefer an installed build, then a portable exe, then the dev checkout. Ordered
# this way so an installed app is not shadowed by a stale source tree.
$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Claude Lifeline\Claude Lifeline.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\claude-lifeline\Claude Lifeline.exe'),
  (Join-Path $repoRoot 'dist\win-unpacked\Claude Lifeline.exe')
)

$target  = $null
$argList = $null

foreach ($candidate in $candidates) {
  if (Test-Path -LiteralPath $candidate) { $target = $candidate; break }
}

if ($target) {
  Write-Info "Using installed app: $target"
} else {
  # Development fallback: drive the local Electron binary directly.
  $electron = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path -LiteralPath $electron)) {
    throw "Could not find an installed Claude Lifeline, and $electron is missing. Run 'npm install' or 'npm run build' first."
  }
  $target  = $electron
  $argList = "`"$repoRoot`""
  Write-Warn2 'No installed build found - pointing the task at the development checkout.'
  Write-Info  "Run 'npm run build' and re-run this script for a standalone install."
}

$action = if ($argList) {
  New-ScheduledTaskAction -Execute $target -Argument $argList -WorkingDirectory $repoRoot
} else {
  New-ScheduledTaskAction -Execute $target -WorkingDirectory (Split-Path -Parent $target)
}

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# StartWhenAvailable catches the case where the machine was asleep at logon time.
# ExecutionTimeLimit 0 means "never kill it" - this is a long-running tray agent,
# and the default 3-day limit would silently stop it.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

# Interactive principal: required for a tray icon and toast notifications.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Info 'Replaced the existing task.'
}

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'Keeps Claude Code sessions alive: shows recovery status in the tray and notifies when a session needs attention.' | Out-Null

Write-Ok "Claude Lifeline will start when you log in."
Write-Info "Task name: $TaskName   (manage it in Task Scheduler)"
Write-Info 'Start it now without logging out:  Start-ScheduledTask -TaskName "Claude Lifeline"'
Write-Host ''
Write-Info 'Reminder: this only autostarts the tray app. Recovery runs inside Claude Code via the hooks,'
Write-Info "so run 'npm run install-hook' if you have not already - that is the part that resumes sessions."
