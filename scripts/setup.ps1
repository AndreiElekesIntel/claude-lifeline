<#
.SYNOPSIS
  One-shot setup: install, register the recovery hooks, create shortcuts, start
  at boot, enable every feature, and launch.

.DESCRIPTION
  Driven by run.bat in the repo root, which exists so this can be started with a
  double-click. Everything is idempotent - re-running repairs a partial install
  rather than duplicating anything.

  Order matters here, and it is not the obvious one. The hooks go in as early as
  possible, because they are the part that actually rescues sessions; the tray
  app, the shortcuts, and autostart are all visibility on top of that. If a later
  step fails, the machine is still protected.

  Nothing in this script needs administrator rights. Everything it writes lives
  under the user's own profile: %APPDATA% for Lifeline's data, ~/.claude for the
  hook registration, the user's Desktop and Start Menu for shortcuts, and a
  per-user Scheduled Task for autostart.

.PARAMETER SkipBuild
  Do not build the packaged .exe. Faster, and autostart then points at the
  development checkout via Electron.

.PARAMETER NoLaunch
  Set everything up but do not start the app.

.PARAMETER Proxy
  HTTPS proxy for npm. Defaults to Intel's, which is required on a corporate
  machine; pass an empty string to install without one.
#>

[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$NoLaunch,
  [string]$Proxy = 'http://proxy-dmz.intel.com:912',
  [string]$HttpProxy = 'http://proxy-dmz.intel.com:911'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$script:stepNo = 0
$script:warnings = @()

function Step ($m) { $script:stepNo++; Write-Host ''; Write-Host "[$script:stepNo] $m" -ForegroundColor Cyan }
function Ok   ($m) { Write-Host "    OK   $m" -ForegroundColor Green }
function Note ($m) { Write-Host "         $m" -ForegroundColor DarkGray }
function Warn ($m) { Write-Host "    WARN $m" -ForegroundColor Yellow; $script:warnings += $m }

Write-Host ''
Write-Host '  Claude Lifeline - setup' -ForegroundColor White
Write-Host '  Keeps Claude Code sessions alive when the API fails.' -ForegroundColor DarkGray
Write-Host ''

# ---------------------------------------------------------------- prerequisites
Step 'Checking prerequisites'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host ''
  Write-Host '    Node.js is required and was not found on PATH.' -ForegroundColor Red
  Write-Host '    Install Node 20 or newer from https://nodejs.org and run this again.' -ForegroundColor Red
  exit 1
}
# No quotes inside the expression: PowerShell strips them before node sees it,
# which turned `.split(".")` into a syntax error and reported "Node 0".
$nodeVersion = ( & node -p 'process.versions.node' )
$nodeMajor = [int](($nodeVersion -split '\.')[0])
if ($nodeMajor -lt 20) {
  Write-Host "    Node $nodeVersion is too old; the hook needs Node 20 or newer." -ForegroundColor Red
  exit 1
}
Ok "Node $nodeVersion"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host '    npm was not found on PATH, though node was. Reinstall Node.js.' -ForegroundColor Red
  exit 1
}

# ------------------------------------------------------------------ dependencies
Step 'Installing dependencies'

# Electron's own postinstall downloads a ~100MB binary, and on a corporate
# network that request needs the proxy too - npm's proxy config does not reach it.
if ($Proxy) {
  Note "Using proxy $Proxy"
  $env:HTTPS_PROXY = $Proxy
  $env:HTTP_PROXY  = $HttpProxy
  $env:npm_config_proxy = $HttpProxy
  $env:npm_config_https_proxy = $Proxy
  # Local mock servers in the test suite must not be proxied.
  $env:NO_PROXY = 'localhost,127.0.0.1,::1,.intel.com'
}

if (Test-Path (Join-Path $repoRoot 'node_modules\electron\dist\electron.exe')) {
  Ok 'Dependencies already present'
  Note 'Delete node_modules and re-run if you want a clean install.'
} else {
  # `npm ci` rather than `install`: package-lock.json is committed, and a
  # reproducible tree is worth more than a chance to pick up newer patches.
  & npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Warn 'npm ci failed; retrying with npm install.'
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
      Write-Host '    Dependency install failed. If you are on a corporate network, check the proxy.' -ForegroundColor Red
      exit 1
    }
  }
  Ok 'Dependencies installed'
}

# ------------------------------------------------------------------------ icons
Step 'Generating icons'
& node scripts/make-icons.mjs | Out-Null
if ($LASTEXITCODE -eq 0) { Ok 'Tray and app icons generated' } else { Warn 'Icon generation failed; the app will fall back to a drawn icon.' }

# ------------------------------------------------------- features, then the hooks
# Config first, because the hook reads it on every failure and a hook installed
# against a half-written config would be running with defaults it did not choose.
Step 'Enabling all features'

$enableAll = @'
const { loadConfig, saveConfig, defaultConfig } = require('./src/shared/config');
const cfg = loadConfig();
const defaults = defaultConfig();

// Every feature on, including the ones that are off by default because they add
// noise rather than observe quietly - nudging on tool failures, sounds - since
// this script is the explicit "yes, all of it" the user asked for.
for (const key of Object.keys(defaults.features)) cfg.features[key] = true;

// respectNonRetryable is the exception, and stays on. It is a *guard*, not a
// feature: clearing it would let Lifeline retry a bad API key forever, which
// burns the attempt budget and buries the message telling you what to fix.
cfg.features.respectNonRetryable = true;

cfg.enabled = true;
cfg.analytics.enabled = true;
cfg.hooks = { ...(cfg.hooks || {}), autoInstall: true, optedOut: false };

// Every error class the table allows to resume, switched on explicitly, so a
// per-class override left over from earlier fiddling does not silently persist.
const { ERROR_CLASSES, POLICIES } = require('./src/shared/policy');
cfg.policies = cfg.policies || {};
for (const cls of ERROR_CLASSES) {
  if (POLICIES[cls].resume) cfg.policies[cls] = { ...(cfg.policies[cls] || {}), resume: true };
}

saveConfig(cfg);
const on = Object.entries(cfg.features).filter(([, v]) => v).length;
console.log(`${on}/${Object.keys(cfg.features).length} features enabled`);
'@

$enableAll | & node --input-type=commonjs -
if ($LASTEXITCODE -eq 0) { Ok 'All features enabled' } else { Warn 'Could not write the config; the app will start with defaults.' }

Step 'Registering recovery hooks with Claude Code'
& node scripts/cli.mjs install
if ($LASTEXITCODE -eq 0) {
  Ok 'Hooks registered'
  Note 'Claude Code loads hooks at startup - restart any session already running.'
} else {
  Warn 'Hook registration failed. Run `npm run doctor` to see why; nothing is protected until this succeeds.'
}

# ------------------------------------------------------------------------- build
if (-not $SkipBuild) {
  Step 'Building the app'
  Note 'First run downloads Electron and takes a few minutes.'
  & node scripts/build.mjs --win --x64
  if ($LASTEXITCODE -eq 0) { Ok 'Build complete' } else { Warn 'Build failed; falling back to running from source.' }
} else {
  Step 'Skipping build (--SkipBuild)'
  Note 'Shortcuts and autostart will run the development checkout.'
}

# --------------------------------------------------------------------- launcher
# Resolved once and reused by both shortcuts and autostart, so they can never
# disagree about which copy of the app is the real one.
Step 'Creating shortcuts'

$exeCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Claude Lifeline\Claude Lifeline.exe'),
  (Join-Path $repoRoot 'dist\win-unpacked\Claude Lifeline.exe')
)
$appExe = $exeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if ($appExe) {
  $targetPath = $appExe
  $targetArgs = ''
  $workDir    = Split-Path -Parent $appExe
  Note "Shortcut target: $appExe"
} else {
  # Development fallback: a .cmd wrapper rather than electron.exe directly, so the
  # shortcut keeps working after `npm install` replaces the binary.
  $launcher = Join-Path $repoRoot 'scripts\launch.cmd'
  @"
@echo off
rem Generated by setup.ps1 - starts Claude Lifeline from this checkout.
cd /d "%~dp0.."
start "" "%~dp0..\node_modules\electron\dist\electron.exe" "%~dp0.."
"@ | Set-Content -Path $launcher -Encoding ASCII
  $targetPath = $launcher
  $targetArgs = ''
  $workDir    = $repoRoot
  Note 'No packaged build found - shortcuts will run from source.'
}

$icon = Join-Path $repoRoot 'assets\icon.ico'
$shell = New-Object -ComObject WScript.Shell

function New-Shortcut ($linkPath, $label) {
  $dir = Split-Path -Parent $linkPath
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $sc = $shell.CreateShortcut($linkPath)
  $sc.TargetPath = $targetPath
  if ($targetArgs) { $sc.Arguments = $targetArgs }
  $sc.WorkingDirectory = $workDir
  $sc.Description = 'Claude Lifeline - keeps Claude Code sessions alive'
  if (Test-Path -LiteralPath $icon) { $sc.IconLocation = $icon }
  $sc.Save()
  Ok "$label"
}

New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claude Lifeline.lnk') 'Desktop shortcut'
New-Shortcut (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Claude Lifeline.lnk') 'Start Menu shortcut'

# -------------------------------------------------------------------- autostart
Step 'Setting it to start at every boot'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-autostart.ps1')
if ($LASTEXITCODE -eq 0) { Ok 'Registered a logon task' } else { Warn 'Autostart registration failed; start the app from the Desktop shortcut instead.' }

# ------------------------------------------------------------------------ verify
Step 'Verifying the installation'
& node scripts/cli.mjs doctor
$doctorFailed = $LASTEXITCODE -ne 0

# ------------------------------------------------------------------------ launch
if (-not $NoLaunch) {
  Step 'Starting Claude Lifeline'
  # Single-instance is enforced in the app itself, so a second launch just
  # surfaces the existing window.
  if ($targetArgs) { Start-Process -FilePath $targetPath -ArgumentList $targetArgs -WorkingDirectory $workDir }
  else { Start-Process -FilePath $targetPath -WorkingDirectory $workDir }
  Ok 'Running - look for the tray icon near the clock'
}

Write-Host ''
if ($script:warnings.Count -eq 0 -and -not $doctorFailed) {
  Write-Host '  Setup complete. Your Claude Code sessions will now resume themselves.' -ForegroundColor Green
} else {
  Write-Host "  Setup finished with $($script:warnings.Count) warning(s):" -ForegroundColor Yellow
  $script:warnings | ForEach-Object { Write-Host "    - $_" -ForegroundColor Yellow }
  if ($doctorFailed) { Write-Host '    - doctor reported problems (see above)' -ForegroundColor Yellow }
}
Write-Host ''
Write-Host '  Useful commands' -ForegroundColor White
Write-Host '    npm run doctor           check every link in the recovery chain' -ForegroundColor DarkGray
Write-Host '    npm run shutdown-check   is it safe to power off right now?' -ForegroundColor DarkGray
Write-Host '    npm run uninstall-hook   remove the hooks again' -ForegroundColor DarkGray
Write-Host ''
