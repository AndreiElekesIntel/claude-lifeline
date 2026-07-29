@echo off
setlocal

rem  Claude Lifeline — double-click installer.
rem
rem  A .bat rather than a .ps1 so it can be launched by double-clicking without
rem  arguing with PowerShell's execution policy. All it does is hand over to
rem  scripts\setup.ps1 with -ExecutionPolicy Bypass, which applies to this process
rem  only and changes nothing machine-wide.
rem
rem  No administrator rights are needed: everything written lives under your own
rem  user profile.
rem
rem  Options are passed straight through:
rem    run.bat -SkipBuild     skip the packaged build and run from source
rem    run.bat -NoLaunch      set everything up but do not start the app
rem    run.bat -Proxy ""      install without a proxy (off the corporate network)

cd /d "%~dp0"

where powershell >nul 2>&1
if errorlevel 1 (
  echo.
  echo   PowerShell was not found on PATH, so setup cannot run.
  echo   Every supported Windows 11 build ships with it; check your PATH.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %*
set "SETUP_EXIT=%ERRORLEVEL%"

echo.
if not "%SETUP_EXIT%"=="0" (
  echo   Setup exited with code %SETUP_EXIT%. Scroll up for the reason.
)

rem  Held open on purpose: launched by double-click, the window would otherwise
rem  vanish with the result in it.
pause
exit /b %SETUP_EXIT%
