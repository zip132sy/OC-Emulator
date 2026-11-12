@echo off
cd /d "%~dp0"
title OC Emulator - Web Control Panel
setlocal EnableDelayedExpansion

REM ============================================================
REM 0. Fix PATH - ensure Windows system directories are available
REM    On some systems (Server Core, minimal installs), these may be missing.
REM ============================================================
set "PATH=%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem;%SystemRoot%\System32\WindowsPowerShell\v1.0;%PATH%"

REM ============================================================
REM Guardian log: records every start / crash exit / hung restart.
REM   Keeps a record even when the console window is closed or the
REM   output has already scrolled away.
REM   NOTE: keep this file ASCII-only. cmd parses batch files with the
REM   active OEM code page, so non-ASCII bytes can shift parsing and run
REM   part of a comment line as a command. Localized text belongs in the
REM   Node / Lua output, which the console renders correctly.
REM ============================================================
set "GUARD_LOG=%~dp0logs\guardian.log"
if not exist "%~dp0logs" mkdir "%~dp0logs" >nul 2>nul

echo ===============================================
echo   OC Emulator - Web Control Panel v2.0
echo ===============================================
echo.

REM ============================================================
REM Required versions
REM ============================================================
set "REQUIRED_NODE_MAJOR=18"
set "NODE_INSTALL_VERSION=v20.17.0"

REM ============================================================
REM 1. Dependency check and install
REM    - Node.js: install when missing; ask before upgrading an old major
REM    - npm packages / Lua: handled by lib\ensureDeps.js
REM      npm version mismatches ask first; Lua is pinned and installed silently
REM    Startup continues only after every dependency is ready.
REM ============================================================
call :ensure_node
if not "!DEP_OK!"=="1" goto :dep_failed

REM Git is needed by automatic updates; a missing Git only warns (startup continues)
call :ensure_git
if not "!GIT_OK!"=="1" (
    echo [WARNING] Git is not installed. Automatic updates will fail.
    echo           Install it from: https://git-scm.com/download/win
)

echo.
echo [INFO] Checking npm packages and Lua...
node "%~dp0lib\ensureDeps.js"
if !ERRORLEVEL! neq 0 goto :dep_failed
echo.

REM ============================================================
REM 2. Dependency integrity check + auto update (lib/startupPrep.js)
REM    - Integrity check can be skipped in the web settings panel.
REM    - Every network step has its own timeout, so a slow or
REM      unreachable network is skipped instead of blocking startup.
REM    - The first run measures GitHub / Gitee speed and caches the
REM      faster source; later runs reuse it.
REM ============================================================
echo.
node "%~dp0lib\startupPrep.js"
if !ERRORLEVEL! neq 0 goto :dep_failed

REM ============================================================
REM 3. Start server with process guardian
REM    - Auto-restart on crash
REM    - Auto-restart on hang (health check timeout)
REM    - Exponential backoff on repeated failures
REM ============================================================
echo.
echo ===============================================
echo   Starting server...
echo   If port 8080 is in use, the server will auto-switch.
echo   Process guardian is ENABLED (auto-restart on crash/hang).
echo ===============================================
echo.

set "RESTART_COUNT=0"
set "MAX_RESTARTS=10"
set "BACKOFF_SECONDS=2"
set "WATCHDOG_INTERVAL=30"
set "WATCHDOG_TIMEOUT=10"

echo.
echo ===============================================
echo   Starting server...
echo   If port 8080 is in use, the server will auto-switch.
echo   Process guardian is ENABLED (auto-restart on crash/hang).
echo ===============================================
echo.

:guardian_loop
set /a RESTART_COUNT+=1
echo [%DATE% %TIME%] Starting server (attempt #!RESTART_COUNT!)...
call :glog "starting server (attempt !RESTART_COUNT!/!MAX_RESTARTS!)"

REM Start a background watchdog that detects a HUNG (not exited) server.
REM   All logic is inlined here on purpose: shipping a separate .ps1 file is
REM   unreliable across machines (it can be missing or blocked by policy).
REM   This writes the watchdog to a temp file and starts a hidden PowerShell.
REM   1) The port and the server PID are read from cache\.server-port and
REM      cache\.server-pid (written atomically by the server at startup).
REM      A hardcoded port silently breaks detection once the server
REM      auto-switches away from a busy port.
REM   2) Missing / unreadable state means "unknown", not "hung": the watchdog
REM      then does nothing for that round. A failed state write or a restart
REM      gap must never cause a healthy server to be killed.
REM   3) It acts only after several consecutive failed probes, plus one
REM      immediate re-check; the startup rounds are ignored entirely.
REM   4) It acts only when the port really has a listening process, and only
REM      when that PID matches the PID recorded by the server (otherwise the
REM      state is stale). Then it first asks /api/server/restart for a
REM      graceful restart and force-kills as the last resort.
REM   5) This script file itself is the sentinel: the guardian deletes it when
REM      the server exits, so the watchdog quits on its next round.
REM   REMINDER: cmd eats a single caret in echo lines, so a regex caret must be
REM   written doubled, and a pipe must be escaped with a caret.
set "PS_WD=%TEMP%\oc_watchdog.ps1"
> "%PS_WD%" echo $pf = '%~dp0cache\.server-port'
>> "%PS_WD%" echo $pidf = '%~dp0cache\.server-pid'
>> "%PS_WD%" echo $iv = %WATCHDOG_INTERVAL%
>> "%PS_WD%" echo $to = %WATCHDOG_TIMEOUT%
>> "%PS_WD%" echo $mf = 3
>> "%PS_WD%" echo $wr = 2
>> "%PS_WD%" echo $sf = '%PS_WD%'
>> "%PS_WD%" echo $lg = '%~dp0logs\guardian.log'
>> "%PS_WD%" echo $f = 0
>> "%PS_WD%" echo $n = 0
>> "%PS_WD%" echo while ($true) {
>> "%PS_WD%" echo   Start-Sleep -Seconds $iv
>> "%PS_WD%" echo   if (-not (Test-Path $sf)) { break }
>> "%PS_WD%" echo   $n = $n + 1
>> "%PS_WD%" echo   $p = 0
>> "%PS_WD%" echo   if (Test-Path $pf) { try { $x = (Get-Content $pf -TotalCount 1).Trim(); if ($x -match '^^[0-9]+$') { $p = [int]$x } } catch {} }
>> "%PS_WD%" echo   if ($p -le 0) { $f = 0; continue }
>> "%PS_WD%" echo   $sp = 0
>> "%PS_WD%" echo   if (Test-Path $pidf) { try { $x = (Get-Content $pidf -TotalCount 1).Trim(); if ($x -match '^^[0-9]+$') { $sp = [int]$x } } catch {} }
>> "%PS_WD%" echo   $h = $false
>> "%PS_WD%" echo   try { if ((Invoke-WebRequest "http://127.0.0.1:$p/api/version" -UseBasicParsing -TimeoutSec $to).StatusCode -eq 200) { $h = $true } } catch {}
>> "%PS_WD%" echo   if ($h) { $f = 0; continue }
>> "%PS_WD%" echo   if ($n -le $wr) { $f = 0; continue }
>> "%PS_WD%" echo   $f = $f + 1
>> "%PS_WD%" echo   if ($f -lt $mf) { continue }
>> "%PS_WD%" echo   $h = $false
>> "%PS_WD%" echo   try { if ((Invoke-WebRequest "http://127.0.0.1:$p/api/version" -UseBasicParsing -TimeoutSec $to).StatusCode -eq 200) { $h = $true } } catch {}
>> "%PS_WD%" echo   if ($h) { $f = 0; continue }
>> "%PS_WD%" echo   $o = 0
>> "%PS_WD%" echo   try { foreach ($l in (netstat -ano ^| Select-String 'LISTENING')) { if ("$l" -match ":$p\s+\S+\s+LISTENING\s+(\d+)") { $o = [int]$Matches[1]; break } } } catch {}
>> "%PS_WD%" echo   if ($o -le 0) { Add-Content $lg "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] watchdog: port $p unresponsive (no listening process)"; $f = 0; continue }
>> "%PS_WD%" echo   if ($sp -gt 0 -and $o -ne $sp) { Add-Content $lg "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] watchdog: port $p unresponsive but listener PID $o differs from recorded PID $sp, skipped"; $f = 0; continue }
>> "%PS_WD%" echo   $g = $false
>> "%PS_WD%" echo   try { if ((Invoke-WebRequest "http://127.0.0.1:$p/api/server/restart" -Method POST -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) { $g = $true } } catch {}
>> "%PS_WD%" echo   if ($g) { Add-Content $lg "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] watchdog: port $p unresponsive, graceful restart requested"; $f = 0; Start-Sleep -Seconds 5; continue }
>> "%PS_WD%" echo   Add-Content $lg "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] watchdog: port $p unresponsive, killed PID $o"
>> "%PS_WD%" echo   Stop-Process -Id $o -Force -ErrorAction SilentlyContinue
>> "%PS_WD%" echo   $f = 0
>> "%PS_WD%" echo   Start-Sleep -Seconds 3
>> "%PS_WD%" echo }

REM Validate the generated script first. A generation failure would fail
REM silently -- no output and no hang protection -- so make it visible.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('%PS_WD%', [ref]$null, [ref]$e); if ($e -and $e.Count) { exit 1 } else { exit 0 }" >nul 2>&1
if !ERRORLEVEL! neq 0 (
    echo [WARNING] watchdog script generation failed. Hang auto-restart is disabled for this run.
    call :glog "watchdog script generation/parse failed"
) else (
    start /b "" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%PS_WD%" >nul 2>&1
)

REM Uptime marker: the server creates this file once it has been up for 60s.
REM The guardian uses its presence to tell "the last run was healthy" and reset
REM the restart budget. A marker file is used instead of date maths or an
REM external PowerShell call, both of which can hang the guardian.
set "UPTIME_MARK=%TEMP%\oc_uptime_ok"
del "%UPTIME_MARK%" >nul 2>nul
set "OC_UPTIME_MARKER=%UPTIME_MARK%"

REM Run server in foreground (output visible to user)
node server.js
set "EXIT_CODE=%ERRORLEVEL%"

set "RAN_LONG=0"
if exist "%UPTIME_MARK%" set "RAN_LONG=1"
del "%UPTIME_MARK%" >nul 2>nul

REM Clean up watchdog script
del "%PS_WD%" >nul 2>nul

REM Server exited (crash or normal stop or killed by watchdog)
echo.
echo [%DATE% %TIME%] Server exited with code !EXIT_CODE!.
call :glog "server exited with code !EXIT_CODE!"
if "!EXIT_CODE!" neq "0" if "!EXIT_CODE!" neq "3" if "!EXIT_CODE!" neq "4" if "!EXIT_CODE!" neq "5" (
    echo [WARNING] server exited abnormally. It crashed, or the watchdog restarted it after a hang.
    echo           details: logs\guardian.log
    call :glog "abnormal exit detected (code !EXIT_CODE!)"
)

REM Exit code 3 = another instance already running.
REM Do NOT restart: otherwise we keep spawning a duplicate instance.
if "!EXIT_CODE!"=="3" (
    echo.
    echo [INFO] An OC Emulator instance is already running.
    echo        Closing this window; please use that instance page.
    call :glog "another instance already running, exiting"
    call :ocsleep 10
    goto :end
)

REM Exit code 4 = stop requested from the web control panel -> do not restart.
if "!EXIT_CODE!"=="4" (
    echo.
    echo [INFO] Stop requested from the web control panel. Exiting.
    call :ocsleep 3
    goto :end
)

REM Exit code 5 = restart requested from the web control panel -> restart at once,
REM and do not count it against the restart budget.
if "!EXIT_CODE!"=="5" (
    echo [INFO] Restart requested from the web control panel.
    set "RESTART_COUNT=0"
    set "BACKOFF_SECONDS=2"
    goto :guardian_loop
)

REM A healthy previous run (the server touched the uptime marker) resets the
REM restart counter and backoff. Otherwise occasional crashes during long
REM sessions keep eating the budget until the guardian gives up for good.
if "!RAN_LONG!"=="1" (
    set "RESTART_COUNT=0"
    set "BACKOFF_SECONDS=2"
    echo [INFO] Previous run was healthy, restart counter reset.
)

if !RESTART_COUNT! geq !MAX_RESTARTS! (
    echo [ERROR] Max restarts reached: %MAX_RESTARTS%. Giving up.
    call :glog "max restarts (%MAX_RESTARTS%) reached, giving up"
    echo server kept failing to start; auto-restart gave up.
    echo see logs\guardian.log, then run this script again.
    call :ocsleep 20
    goto :end
)

echo [%DATE% %TIME%] Restarting in !BACKOFF_SECONDS!s (attempt !RESTART_COUNT!/!MAX_RESTARTS!)...
call :glog "restarting in !BACKOFF_SECONDS!s (attempt !RESTART_COUNT!/!MAX_RESTARTS!)"
echo.
call :ocsleep !BACKOFF_SECONDS!

REM Exponential backoff (max 30s)
set /a BACKOFF_SECONDS*=2
if !BACKOFF_SECONDS! gtr 30 set "BACKOFF_SECONDS=30"

REM Reset backoff after successful run ^> 60s? Keep simple for now.
goto :guardian_loop

:dep_failed
echo.
echo [ERROR] Dependencies are not ready; server not started.
echo         Fix the issues above, then run this script again.
echo.
pause
goto :end

:end
exit /b 0

REM ------------------------------------------------------------
REM Subroutine: check / install Node.js
REM   - installed and major version OK -> DEP_OK=1
REM   - missing -> download and install
REM   - too old -> ask before downloading and installing
REM ------------------------------------------------------------
:ensure_node
set "DEP_OK=0"
set "NODE_MAJOR="
set "NODE_VERSION="
where node >nul 2>nul
if %ERRORLEVEL% neq 0 goto :en_missing
for /f "tokens=*" %%v in ('node --version 2^>nul') do set "NODE_VERSION=%%v"
for /f "delims=." %%v in ("!NODE_VERSION!") do set "NODE_MAJOR=%%v"
set "NODE_MAJOR=!NODE_MAJOR:v=!"
if "!NODE_MAJOR!"=="" goto :en_missing
if !NODE_MAJOR! lss %REQUIRED_NODE_MAJOR% goto :en_old
echo [OK] Node.js !NODE_VERSION!
set "DEP_OK=1"
goto :eof

:en_old
echo [WARNING] Node.js !NODE_VERSION! is older than the required v%REQUIRED_NODE_MAJOR%+.
choice /C YN /M "Download and install Node.js %NODE_INSTALL_VERSION%"
if errorlevel 2 (
    echo [ERROR] Cancelled: Node.js version requirement not met.
    goto :eof
)
goto :en_install

:en_missing
echo [INFO] Node.js not found, installing automatically...
goto :en_install

:en_install
set "NODE_ARCH=x64"
if "%PROCESSOR_ARCHITECTURE%"=="x86" (
    if not defined PROCESSOR_ARCHITEW6432 set "NODE_ARCH=x86"
)
set "NODE_URL=https://nodejs.org/dist/%NODE_INSTALL_VERSION%/node-%NODE_INSTALL_VERSION%-!NODE_ARCH!.msi"
set "NODE_INSTALLER=%TEMP%\node-%NODE_INSTALL_VERSION%-!NODE_ARCH!.msi"

echo.
echo [INFO] Downloading Node.js %NODE_INSTALL_VERSION% (!NODE_ARCH!)...
echo        !NODE_URL!
call :download "!NODE_URL!" "!NODE_INSTALLER!"
if not exist "!NODE_INSTALLER!" (
    echo [ERROR] Node.js download failed after retries.
    goto :en_fail
)

echo.
echo [INFO] Installing Node.js; allow the permission prompt if it appears...
msiexec /i "!NODE_INSTALLER!" /qb /norestart
if !ERRORLEVEL! neq 0 (
    echo [INFO] Retrying as a per-user install...
    msiexec /i "!NODE_INSTALLER!" /qb /norestart INSTALLDIR="%LOCALAPPDATA%\Nodejs"
)
del "!NODE_INSTALLER!" >nul 2>nul

set "PATH=%ProgramFiles%\nodejs;%LOCALAPPDATA%\Nodejs;%PATH%"
where node >nul 2>nul
if %ERRORLEVEL% neq 0 goto :en_fail
for /f "tokens=*" %%v in ('node --version 2^>nul') do set "NODE_VERSION=%%v"
echo [OK] Node.js installed: !NODE_VERSION!
set "DEP_OK=1"
goto :eof

:en_fail
echo.
echo [ERROR] Node.js installation failed.
echo         Install Node.js manually, then run this script again: https://nodejs.org/
echo.
goto :eof

REM ------------------------------------------------------------
REM Subroutine: check / install Git
REM   - installed -> GIT_OK=1
REM   - missing   -> try winget, then Chocolatey, then Scoop
REM   - failure is not fatal: the emulator starts, updates are skipped
REM ------------------------------------------------------------
:ensure_git
set "GIT_OK=0"
set "GIT_VERSION="
where git >nul 2>nul
if %ERRORLEVEL% equ 0 goto :eg_found

echo [INFO] Git not found, trying winget...
call :eg_try_winget
call :eg_refresh_path
where git >nul 2>nul
if %ERRORLEVEL% equ 0 goto :eg_found

echo [INFO] Trying Chocolatey...
call :eg_try_choco
call :eg_refresh_path
where git >nul 2>nul
if %ERRORLEVEL% equ 0 goto :eg_found

echo [INFO] Trying Scoop...
call :eg_try_scoop
call :eg_refresh_path
where git >nul 2>nul
if %ERRORLEVEL% equ 0 goto :eg_found
goto :eg_manual

:eg_try_winget
where winget >nul 2>nul
if %ERRORLEVEL% neq 0 goto :eof
winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements --silent
goto :eof

:eg_try_choco
where choco >nul 2>nul
if %ERRORLEVEL% neq 0 goto :eof
choco install git -y
goto :eof

:eg_try_scoop
where scoop >nul 2>nul
if %ERRORLEVEL% neq 0 goto :eof
call scoop install git
goto :eof

REM Make a just-installed Git visible to the commands that follow
:eg_refresh_path
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" set "PATH=%LOCALAPPDATA%\Programs\Git\cmd;%PATH%"
if exist "%USERPROFILE%\scoop\shims\git.exe" set "PATH=%USERPROFILE%\scoop\shims;%PATH%"
if exist "%ProgramData%\chocolatey\bin\git.exe" set "PATH=%ProgramData%\chocolatey\bin;%PATH%"
goto :eof

:eg_found
for /f "tokens=*" %%v in ('git --version 2^>nul') do set "GIT_VERSION=%%v"
echo [OK] !GIT_VERSION!
set "GIT_OK=1"
goto :eof

:eg_manual
echo [WARNING] Git could not be installed automatically.
echo           Download it from https://git-scm.com/download/win and run this script again.
echo           The emulator still starts; only automatic updates are skipped.
echo.
goto :eof

REM ------------------------------------------------------------
REM Subroutine: download with progress and retries
REM   usage: call :download <url> <dest>
REM   creates <dest> on success; leaves it absent on failure
REM ------------------------------------------------------------
:download
set "_dl_url=%~1"
set "_dl_dest=%~2"
set "_dl_part=%~2.part"
set "_dl_ok=0"
if exist "%_dl_part%" del "%_dl_part%" >nul 2>nul

where curl >nul 2>nul
if !ERRORLEVEL! equ 0 (
    echo [download] Downloading with curl...
    curl.exe -L --fail --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 900 -o "%_dl_part%" "%_dl_url%"
    if !ERRORLEVEL! equ 0 (
        if exist "%_dl_part%" set "_dl_ok=1"
    )
)

if "!_dl_ok!"=="0" (
    if exist "%_dl_part%" del "%_dl_part%" >nul 2>nul
    echo [download] Downloading with PowerShell...
    set "_dl_ps=%TEMP%\oc_download.ps1"
    > "!_dl_ps!" echo $ProgressPreference = 'Continue'
    >> "!_dl_ps!" echo [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    >> "!_dl_ps!" echo try { Invoke-WebRequest -Uri '!_dl_url!' -OutFile '!_dl_part!' -UseBasicParsing; exit 0 } catch { exit 1 }
    "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "!_dl_ps!"
    if !ERRORLEVEL! equ 0 (
        if exist "!_dl_part!" set "_dl_ok=1"
    )
    del "!_dl_ps!" >nul 2>nul
)

if "!_dl_ok!"=="1" (
    move /y "!_dl_part!" "%_dl_dest%" >nul
    exit /b 0
)
if exist "%_dl_part%" del "%_dl_part%" >nul 2>nul
exit /b 1

REM ------------------------------------------------------------
REM Subroutine: append a line to the guardian log (logs\guardian.log)
REM   Usage: call :glog "message"
REM   Keep the space after %~1: without it a message that ends in a digit
REM   becomes a file-descriptor redirect (e.g. "code 2>> file").
REM ------------------------------------------------------------
:glog
if defined GUARD_LOG echo [%DATE% %TIME%] %~1 >> "%GUARD_LOG%" 2>nul
goto :eof

REM ------------------------------------------------------------
REM Robust delay helper (seconds). Works even when stdin is not
REM an interactive console. Do NOT use `timeout` here: it aborts
REM the whole script when input redirection is not supported.
REM ------------------------------------------------------------
:ocsleep
setlocal
set /a _ocs=%~1+1
if %_ocs% lss 2 set /a _ocs=2
ping -n %_ocs% 127.0.0.1 >nul 2>&1
endlocal
goto :eof
