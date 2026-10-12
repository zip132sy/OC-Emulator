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
REM 守护日志: 记录每次启动 / 崩溃退出 / 卡死重启。
REM   即使命令行窗口被关闭或输出被滚动掉, 也能事后查看发生了什么。
REM ============================================================
set "GUARD_LOG=%~dp0logs\guardian.log"
if not exist "%~dp0logs" mkdir "%~dp0logs" >nul 2>nul

echo ===============================================
echo   OC Emulator - Web Control Panel v2.0
echo ===============================================
echo.

REM ============================================================
REM 依赖版本要求
REM ============================================================
set "REQUIRED_NODE_MAJOR=18"
set "NODE_INSTALL_VERSION=v20.17.0"

REM ============================================================
REM 1. 依赖检查与安装
REM    - Node.js:   未安装则自动安装; 主版本过低则询问后安装
REM    - npm 依赖 / Lua: 交给 lib\ensureDeps.js
REM      (npm 依赖版本不符会询问; Lua 强制固定 5.1.x, 不询问直接安装)
REM    只有依赖全部就绪才会继续启动。
REM ============================================================
call :ensure_node
if not "!DEP_OK!"=="1" goto :dep_failed

echo.
echo [INFO] 检查 npm 依赖与 Lua...
node "%~dp0lib\ensureDeps.js"
if !ERRORLEVEL! neq 0 goto :dep_failed
echo.

REM ============================================================
REM 2. 依赖文件自检与联网修复
REM    强依赖文件缺失时从远端仓库下载恢复 (GitHub 优先, Gitee 回退)
REM ============================================================
echo.
echo [INFO] 检查依赖文件完整性...
node "%~dp0lib\repair.js"
if !ERRORLEVEL! neq 0 goto :dep_failed

REM ============================================================
REM 3. Auto update (enabled by default; toggle in the web settings panel)
REM    Pull the latest version from the remote before starting.
REM ============================================================
set "AUTO_UPDATE=on"
if not exist settings.json goto :update_read_done

set "PS_AU=%TEMP%\read_autoupdate.ps1"
set "AU_OUT=%TEMP%\read_autoupdate.txt"
echo try { $s = Get-Content 'settings.json' ^| ConvertFrom-Json; if ($s.autoUpdate -eq $false) { 'off' } else { 'on' } } catch { 'on' } > "%PS_AU%"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%PS_AU%" > "%AU_OUT%" 2>nul
del "%PS_AU%" >nul 2>nul
for /f "usebackq delims=" %%u in ("%AU_OUT%") do set "AUTO_UPDATE=%%u"
del "%AU_OUT%" >nul 2>nul

:update_read_done
if /i "!AUTO_UPDATE!"=="off" (
    echo [INFO] Auto update is OFF ^(enable it in the web settings panel^).
    goto :update_done
)
if not exist ".git" (
    echo [INFO] Not a git repository, skipping auto update.
    goto :update_done
)
where git >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [INFO] git not found, skipping auto update.
    goto :update_done
)
echo [INFO] Checking for updates...
git pull --ff-only --quiet
if !ERRORLEVEL! neq 0 (
    echo [INFO] Pull from default remote failed, trying 'github'...
    git pull --ff-only --quiet github main
)
if !ERRORLEVEL! neq 0 (
    echo [WARNING] Auto update failed ^(ignored, continuing^).
) else (
    echo [OK] Update check finished.
)
:update_done

REM ============================================================
REM 4. Start server with process guardian
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
set "WATCHDOG_PORT=8080"
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

REM Start watchdog in background to detect hangs.
REM   看门狗本体在 lib\watchdog.ps1。这里只创建一个"哨兵文件": 守护脚本结束时删掉它,
REM   看门狗发现哨兵消失就会自行退出。
REM   端口由 -PortFile 传入 (服务器启动时会把实际端口写进 cache\.server-port),
REM   因此即使服务器因 8080 被占用换到别的端口, 看门狗也能找到它。
set "PS_WD=%TEMP%\oc_watchdog.ps1"
> "%PS_WD%" echo stop

if not exist "%~dp0lib\watchdog.ps1" (
    echo [WARNING] lib\watchdog.ps1 缺失, 本次不启用"卡死自动重启"；崩溃仍会自动重启。
    echo           可运行: node lib\repair.js  恢复该文件。
    call :glog "watchdog script missing, hang-detection disabled"
    goto :wd_started
)

start /b "" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0lib\watchdog.ps1" -Port %WATCHDOG_PORT% -PortFile "%~dp0cache\.server-port" -Interval %WATCHDOG_INTERVAL% -Timeout %WATCHDOG_TIMEOUT% -Sentinel "%PS_WD%" -LogFile "%~dp0logs\guardian.log" >nul 2>&1

:wd_started

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
    echo [WARNING] 服务异常退出: 崩溃, 或被看门狗判定为卡死后重启。
    echo           详细记录: logs\guardian.log
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
    echo 服务反复启动失败, 已放弃自动重启。
    echo 请查看 logs\guardian.log, 处理完之后再重新运行本脚本。
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
echo [ERROR] 依赖未就绪, 服务器未启动。
echo         请按上面的提示处理依赖后重新运行本脚本。
echo.
pause
goto :end

:end
exit /b 0

REM ------------------------------------------------------------
REM 子程序: 检查 / 安装 Node.js
REM   - 已安装且满足主版本要求 -> DEP_OK=1
REM   - 未安装 -> 自动下载安装
REM   - 主版本过低 -> 询问是否下载安装
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
echo [WARNING] 当前 Node.js !NODE_VERSION! 低于要求的 v%REQUIRED_NODE_MAJOR%+。
choice /C YN /M "是否下载并安装 Node.js %NODE_INSTALL_VERSION%"
if errorlevel 2 (
    echo [ERROR] 已取消: Node.js 版本未满足要求。
    goto :eof
)
goto :en_install

:en_missing
echo [INFO] 未检测到 Node.js, 开始自动安装...
goto :en_install

:en_install
set "NODE_ARCH=x64"
if "%PROCESSOR_ARCHITECTURE%"=="x86" (
    if not defined PROCESSOR_ARCHITEW6432 set "NODE_ARCH=x86"
)
set "NODE_URL=https://nodejs.org/dist/%NODE_INSTALL_VERSION%/node-%NODE_INSTALL_VERSION%-win-!NODE_ARCH!.msi"
set "NODE_INSTALLER=%TEMP%\node-%NODE_INSTALL_VERSION%-win-!NODE_ARCH!.msi"

echo.
echo [INFO] 正在下载 Node.js %NODE_INSTALL_VERSION% (!NODE_ARCH!)...
echo        !NODE_URL!
call :download "!NODE_URL!" "!NODE_INSTALLER!"
if not exist "!NODE_INSTALLER!" (
    echo [ERROR] Node.js 下载失败 ^(已重试^)。
    goto :en_fail
)

echo.
echo [INFO] 正在安装 Node.js ^(如弹出权限提示请允许^)...
msiexec /i "!NODE_INSTALLER!" /qb /norestart
if !ERRORLEVEL! neq 0 (
    echo [INFO] 尝试按当前用户安装...
    msiexec /i "!NODE_INSTALLER!" /qb /norestart INSTALLDIR="%LOCALAPPDATA%\Nodejs"
)
del "!NODE_INSTALLER!" >nul 2>nul

set "PATH=%ProgramFiles%\nodejs;%LOCALAPPDATA%\Nodejs;%PATH%"
where node >nul 2>nul
if %ERRORLEVEL% neq 0 goto :en_fail
for /f "tokens=*" %%v in ('node --version 2^>nul') do set "NODE_VERSION=%%v"
echo [OK] Node.js 安装完成: !NODE_VERSION!
set "DEP_OK=1"
goto :eof

:en_fail
echo.
echo [ERROR] Node.js 安装未成功。
echo         请手动安装 Node.js 后重新运行本脚本: https://nodejs.org/
echo.
goto :eof

REM ------------------------------------------------------------
REM 子程序: 带进度显示与重试的下载
REM   用法: call :download <url> <dest>
REM   成功时生成 <dest>, 失败时不生成 (返回码非 0)
REM ------------------------------------------------------------
:download
set "_dl_url=%~1"
set "_dl_dest=%~2"
set "_dl_part=%~2.part"
set "_dl_ok=0"
if exist "%_dl_part%" del "%_dl_part%" >nul 2>nul

where curl >nul 2>nul
if !ERRORLEVEL! equ 0 (
    echo [download] 使用 curl 下载 ^(显示实时进度^)...
    curl.exe -L --fail --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 900 -o "%_dl_part%" "%_dl_url%"
    if !ERRORLEVEL! equ 0 (
        if exist "%_dl_part%" set "_dl_ok=1"
    )
)

if "!_dl_ok!"=="0" (
    if exist "%_dl_part%" del "%_dl_part%" >nul 2>nul
    echo [download] 使用 PowerShell 下载 ^(显示实时进度^)...
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
REM 子程序: 写守护日志 (logs\guardian.log)
REM   用法: call :glog "message"
REM   注意 %~1 后面的空格: 避免消息以数字结尾时被 cmd 当成
REM   文件描述符重定向 (例如 "code 2>> file" 会把输出写到 stderr)。
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
