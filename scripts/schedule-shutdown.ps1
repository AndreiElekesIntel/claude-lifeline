<#
.SYNOPSIS
  Schedule the "shut down when all sessions are finished" check.

.DESCRIPTION
  Registers a Scheduled Task that runs scripts/idle-shutdown.mjs at a given
  time. The task, not a background shell, is what makes this reliable: a process
  started from a terminal dies with that terminal, and the whole point of a 5am
  check is that nobody is watching it.

  The check itself never shuts down a machine with work in flight - see
  src/shared/idle-shutdown.js. It refuses on a busy session, a turn that ended
  mid-tool-call, a recent recovery attempt, or anything needing attention, and
  keeps re-checking through the grace period before giving up and leaving the
  machine on.

  One-time by default. A recurring auto-shutdown is a bigger commitment than it
  looks, so -Daily is opt-in.

.PARAMETER At
  Local time, HH:mm. Defaults to 05:00. Tomorrow if today's time has passed.

.PARAMETER Daily
  Repeat every day instead of running once.

.PARAMETER GraceMinutes
  How long to keep re-checking after the deadline. Default 90.

.PARAMETER DryRun
  Register a task that reports its decision but never shuts down. Use this first.

.PARAMETER Uninstall
  Remove the task.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\schedule-shutdown.ps1 -At 05:00

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\schedule-shutdown.ps1 -DryRun

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\schedule-shutdown.ps1 -Uninstall
#>

[CmdletBinding()]
param(
  [string]$At = '05:00',
  [switch]$Daily,
  [int]$GraceMinutes = 90,
  [switch]$DryRun,
  [switch]$Uninstall,
  [string]$TaskName = 'Claude Lifeline - Idle Shutdown'
)

$ErrorActionPreference = 'Stop'

function Write-Ok   ($m) { Write-Host "OK   $m" -ForegroundColor Green }
function Write-Info ($m) { Write-Host "     $m" -ForegroundColor DarkGray }
function Write-Warn2($m) { Write-Host "WARN $m" -ForegroundColor Yellow }

if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
  throw 'The ScheduledTasks module is unavailable. Schedule the task manually via Task Scheduler.'
}

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Ok "Removed '$TaskName'. This machine will not shut itself down."
  } else {
    Write-Warn2 "No task named '$TaskName' was found. Nothing to remove."
  }
  exit 0
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$script   = Join-Path $repoRoot 'scripts\idle-shutdown.mjs'
if (-not (Test-Path -LiteralPath $script)) { throw "Cannot find $script." }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node was not found on PATH. The check needs Node 20+.' }

# Parsed rather than passed through, so a bad value fails here instead of at 5am.
try {
  $when = [datetime]::ParseExact($At, 'HH:mm', $null)
} catch {
  throw "Invalid -At '$At': expected 24-hour HH:mm, e.g. 05:00."
}
$target = (Get-Date).Date.AddHours($when.Hour).AddMinutes($when.Minute)
if ($target -le (Get-Date)) { $target = $target.AddDays(1) }

# --now, because the trigger already handles the waiting. Letting the script wait
# too would mean two clocks disagreeing about when 5am is.
$argList = "`"$script`" --now --grace $GraceMinutes"
if ($DryRun) { $argList += ' --dry-run' }

$logDir = Join-Path $env:APPDATA 'claude-lifeline\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'idle-shutdown.log'

# cmd /c wraps it purely to capture output: a Scheduled Task discards stdout, and
# the morning question is always "why is the machine still on?".
$action = New-ScheduledTaskAction -Execute 'cmd.exe' `
  -Argument "/c `"`"$node`" $argList >> `"$logFile`" 2>&1`"" `
  -WorkingDirectory $repoRoot

$trigger = if ($Daily) {
  New-ScheduledTaskTrigger -Daily -At $target
} else {
  New-ScheduledTaskTrigger -Once -At $target
}

# WakeToRun so a sleeping laptop still gets checked; without it the task simply
# never fires and the machine stays on all day.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -WakeToRun `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4) `
  -MultipleInstances IgnoreNew

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
  -Description 'Shuts this machine down only if every Claude Code session has genuinely finished. Refuses on busy sessions, interrupted turns, pending recoveries, or anything needing attention.' | Out-Null

Write-Ok "Scheduled for $($target.ToString('dddd d MMMM, HH:mm'))$(if ($Daily) { ', repeating daily' } else { ' (once)' })."
if ($DryRun) { Write-Warn2 'DRY RUN: it will report its decision and shut nothing down.' }
Write-Info "Grace period: $GraceMinutes min of re-checks before giving up."
Write-Info "Log: $logFile"
Write-Host ''
Write-Info 'It will NOT shut down if a session is busy, a turn ended mid-tool-call, a recovery'
Write-Info 'happened recently, or anything needs your attention. Check now with: npm run shutdown-check'
Write-Info "Cancel:  powershell -File scripts\schedule-shutdown.ps1 -Uninstall"
Write-Info 'If a shutdown does start, you have 60 seconds to stop it with:  shutdown /a'
