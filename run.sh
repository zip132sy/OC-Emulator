#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "==============================================="
echo "  OC Emulator - Web Control Panel v2.0"
echo "==============================================="
echo ""

# ------------------------------------------------------------
# 守护日志: 记录每次启动 / 崩溃退出 / 卡死重启。
#   即使终端输出被滚动掉或窗口被关闭, 也能事后查看发生了什么。
# ------------------------------------------------------------
GUARD_LOG="$(pwd)/logs/guardian.log"
mkdir -p "$(dirname "$GUARD_LOG")" 2>/dev/null
glog() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$GUARD_LOG" 2>/dev/null || true; }

# ============================================================
# 1. Dependencies: Node.js
#    - not installed        -> install automatically
#    - major version too low -> ask before installing
# ============================================================
REQUIRED_NODE_MAJOR=18

install_node() {
    echo ""
    echo "Attempting to install Node.js..."
    echo ""

    OS_TYPE="$(uname -s)"
    INSTALL_SUCCESS=false

    case "$OS_TYPE" in
        Linux*)
            # Try package managers
            if command -v apt-get >/dev/null 2>&1; then
                echo "Installing via apt-get (requires sudo)..."
                sudo apt-get update -qq && sudo apt-get install -y nodejs npm
                INSTALL_SUCCESS=true
            elif command -v yum >/dev/null 2>&1; then
                echo "Installing via yum (requires sudo)..."
                sudo yum install -y nodejs npm
                INSTALL_SUCCESS=true
            elif command -v dnf >/dev/null 2>&1; then
                echo "Installing via dnf (requires sudo)..."
                sudo dnf install -y nodejs npm
                INSTALL_SUCCESS=true
            elif command -v pacman >/dev/null 2>&1; then
                echo "Installing via pacman (requires sudo)..."
                sudo pacman -S --noconfirm nodejs npm
                INSTALL_SUCCESS=true
            elif command -v apk >/dev/null 2>&1; then
                echo "Installing via apk (requires sudo)..."
                sudo apk add nodejs npm
                INSTALL_SUCCESS=true
            else
                echo "No known package manager found."
            fi
            ;;
        Darwin*)
            if command -v brew >/dev/null 2>&1; then
                echo "Installing via Homebrew..."
                brew install node
                INSTALL_SUCCESS=true
            elif command -v port >/dev/null 2>&1; then
                echo "Installing via MacPorts (requires sudo)..."
                sudo port install nodejs20
                INSTALL_SUCCESS=true
            else
                echo "Neither Homebrew nor MacPorts found."
                echo "Install Homebrew from: https://brew.sh/"
            fi
            ;;
        *)
            echo "Unknown OS: $OS_TYPE"
            ;;
    esac

    # If package manager install didn't work, try nvm
    if [ "$INSTALL_SUCCESS" = false ] || ! command -v node >/dev/null 2>&1; then
        echo ""
        echo "Package manager install failed or unavailable."
        echo "Trying nvm (Node Version Manager)..."
        echo ""

        NVM_DIR="$HOME/.nvm"
        if [ ! -d "$NVM_DIR" ]; then
            curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh 2>/dev/null | bash
        fi

        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        nvm install --lts 2>/dev/null && nvm use --lts 2>/dev/null
    fi
}

if ! command -v node >/dev/null 2>&1; then
    echo "[WARNING] Node.js not found in PATH."
    install_node
    if ! command -v node >/dev/null 2>&1; then
        echo ""
        echo "[ERROR] Could not install Node.js automatically."
        echo "Please install Node.js manually:"
        echo "  - Linux: https://nodejs.org/en/download/package-manager/"
        echo "  - macOS: https://nodejs.org/en/download/ or run: brew install node"
        echo "  - Or use nvm: https://github.com/nvm-sh/nvm"
        echo ""
        exit 1
    fi
    echo "Node.js installed successfully!"
fi

NODE_VERSION="$(node --version 2>/dev/null)"
echo "[OK] Node.js: $NODE_VERSION"

NODE_MAJOR="$(echo "$NODE_VERSION" | sed 's/^v//; s/\..*//')"
if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ] 2>/dev/null; then
    echo "[WARNING] Node.js $NODE_VERSION is older than required v${REQUIRED_NODE_MAJOR}+."
    if [ -t 0 ]; then
        printf "Download and install a newer Node.js now? [Y/N] "
        read -r _ans
    else
        _ans="N"
    fi
    case "$_ans" in
        [Yy]*)
            install_node
            if ! command -v node >/dev/null 2>&1; then
                echo "[ERROR] Node.js is still unavailable. Aborting."
                exit 1
            fi
            NODE_VERSION="$(node --version 2>/dev/null)"
            echo "[OK] Node.js: $NODE_VERSION"
            ;;
        *)
            echo "[ERROR] Dependency version not satisfied. Server not started."
            exit 1
            ;;
    esac
fi

# ============================================================
# 2. npm dependencies + Lua (lib/ensureDeps.js)
#    - npm dependency version mismatch -> ask before reinstalling
#    - Lua is pinned to 5.1.x (no prompt)
#    Only start after all dependencies are satisfied.
# ============================================================
echo ""
if ! node lib/ensureDeps.js; then
    echo ""
    echo "[ERROR] Dependencies are not satisfied. Server not started."
    exit 1
fi
echo ""

# ============================================================
# 3. Dependency integrity check + auto update (lib/startupPrep.js)
#    - Integrity check can be skipped in the web settings panel.
#    - Every network step has its own timeout; a slow or unreachable
#      network is skipped instead of blocking startup.
#    - The first run measures GitHub / Gitee speed and caches the
#      faster source; later runs reuse it.
# ============================================================
echo ""
echo "[INFO] Checking dependency files and updates..."
if command -v timeout >/dev/null 2>&1; then
    timeout 150 node lib/startupPrep.js
    PREP_CODE=$?
else
    node lib/startupPrep.js
    PREP_CODE=$?
fi
if [ "$PREP_CODE" -eq 124 ]; then
    echo "[WARNING] Startup pre-check timed out; continuing."
elif [ "$PREP_CODE" -ne 0 ]; then
    echo ""
    echo "[ERROR] Some required files are missing and could not be repaired."
    echo "        Check your network and retry, or re-clone the repository."
    exit 1
fi

# ============================================================
# 4. Start server with process guardian
#    - Auto-restart on crash
#    - Auto-restart on hang (health check timeout)
#    - Exponential backoff on repeated failures
#    - Single-instance guard (exit code 3 => do not restart)
# ============================================================
echo ""
echo "==============================================="
echo "  Starting server..."
echo "  If port 8080 is in use, the server will auto-switch."
echo "  Process guardian is ENABLED (auto-restart on crash/hang)."
echo "==============================================="
echo ""

RESTART_COUNT=0
MAX_RESTARTS=10
BACKOFF_SECONDS=2
# 服务器启动时会把"实际监听端口"和"自己的进程号"写到这两个文件; 配置端口(8080)被
# 占用时服务器会自动换到 8081 等端口, 看门狗若只认 8080 就会监视错误端口 ——
# 结果是服务真的卡死时反而没人管。这里始终以文件里的实际值为准。
WATCHDOG_PORT_FILE="$(pwd)/cache/.server-port"
WATCHDOG_PID_FILE="$(pwd)/cache/.server-pid"
WATCHDOG_INTERVAL=30
WATCHDOG_TIMEOUT=10
# 连续 N 次探测失败才认为卡死 (每次间隔 WATCHDOG_INTERVAL 秒)。
WATCHDOG_MAX_FAILS=3
# 服务器刚启动的前 N 轮不做判定: 此时端口可能还没开始监听、状态文件也可能还没写。
WATCHDOG_WARMUP_ROUNDS=2

WATCHDOG_SENTINEL=""
WATCHDOG_PID=""

# Find the PID listening on a given TCP port (Linux / macOS)
find_pid_on_port() {
    _port="$1"
    if command -v lsof >/dev/null 2>&1; then
        lsof -ti "tcp:${_port}" -sTCP:LISTEN 2>/dev/null | head -n 1
        return
    fi
    if command -v ss >/dev/null 2>&1; then
        ss -ltnp 2>/dev/null | grep ":${_port} " | grep -o 'pid=[0-9]*' | head -n 1 | cut -d= -f2
        return
    fi
    if command -v netstat >/dev/null 2>&1; then
        netstat -anp 2>/dev/null | grep -i listen | grep ":${_port} " | awk '{print $NF}' | head -n 1 | cut -d/ -f1
        return
    fi
    echo ""
}

# HTTP 探测: 优先 curl, 退回 wget。
# 两者都没有时由 start_watchdog 直接禁用卡死检测 —— 否则健康检查永远失败,
# 会把本来正常的服务反复杀掉。
http_probe() {
    _url="$1"
    _timeout="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fsS --max-time "$_timeout" "$_url" >/dev/null 2>&1
        return $?
    fi
    if command -v wget >/dev/null 2>&1; then
        wget -q -T "$_timeout" -O /dev/null "$_url" >/dev/null 2>&1
        return $?
    fi
    return 1
}

http_post() {
    _url="$1"
    _timeout="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fsS --max-time "$_timeout" -X POST "$_url" >/dev/null 2>&1
        return $?
    fi
    if command -v wget >/dev/null 2>&1; then
        wget -q -T "$_timeout" --method=POST -O /dev/null "$_url" >/dev/null 2>&1
        return $?
    fi
    return 1
}

# Background watchdog: health-check the server periodically and force-kill it
# if it stops responding (the main loop is responsible for restarting it).
# It exits by itself once the sentinel file is removed.
start_watchdog() {
    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        echo "[WARNING] 未找到 curl / wget, 本次不启用\"卡死自动重启\"；崩溃仍会自动重启。"
        glog "no curl/wget available, hang-detection disabled"
        return
    fi
    WATCHDOG_SENTINEL="$(mktemp -t oc_watchdog.XXXXXX 2>/dev/null || echo "/tmp/oc_watchdog.$$")"
    (
        _wf=0     # 连续探测失败次数
        _wr=0     # 已运行的轮数 (用于启动宽限期)
        while true; do
            sleep "$WATCHDOG_INTERVAL"
            # Main loop finished -> watchdog stops too
            [ -f "$WATCHDOG_SENTINEL" ] || exit 0
            _wr=$((_wr + 1))

            # 端口与进程号以服务器写入的实际值为准; 文件缺失/内容非法时本轮不做任何判定:
            # 状态缺失可能只是写文件失败, 也可能正处在重启的空档, 这时重启服务只会误伤
            # 正在正常工作的进程。宁可少管一次, 也不要错误地杀掉健康的服务。
            _wd_port=""
            if [ -f "$WATCHDOG_PORT_FILE" ]; then
                _p="$(head -n 1 "$WATCHDOG_PORT_FILE" 2>/dev/null | tr -d '[:space:]')"
                case "$_p" in
                    ''|*[!0-9]*) : ;;
                    *) _wd_port="$_p" ;;
                esac
            fi
            if [ -z "$_wd_port" ]; then
                _wf=0
                continue
            fi
            _wd_pid=""
            if [ -f "$WATCHDOG_PID_FILE" ]; then
                _p="$(head -n 1 "$WATCHDOG_PID_FILE" 2>/dev/null | tr -d '[:space:]')"
                case "$_p" in
                    ''|*[!0-9]*) : ;;
                    *) _wd_pid="$_p" ;;
                esac
            fi

            if http_probe "http://127.0.0.1:${_wd_port}/api/version" "$WATCHDOG_TIMEOUT"; then
                _wf=0
                continue
            fi

            # 启动宽限期: 服务器可能还在起服务(磁盘镜像同步等 IO 会阻塞事件循环),
            # 这段时间里的探测失败不能算作卡死。
            if [ "$_wr" -le "$WATCHDOG_WARMUP_ROUNDS" ]; then
                _wf=0
                continue
            fi

            # 连续失败才动手: 服务可能只是短暂繁忙(磁盘操作会阻塞事件循环数十秒),
            # 一次失败就杀掉会误伤正常运行中的服务。
            _wf=$((_wf + 1))
            if [ "$_wf" -lt "$WATCHDOG_MAX_FAILS" ]; then
                continue
            fi

            # 已经连续失败多轮, 动手前再立刻复查一次, 避免把偶发的探测失败当成卡死。
            if http_probe "http://127.0.0.1:${_wd_port}/api/version" "$WATCHDOG_TIMEOUT"; then
                _wf=0
                continue
            fi

            _hung_pid="$(find_pid_on_port "$_wd_port")"
            if [ -z "$_hung_pid" ]; then
                # 端口上根本没有监听进程: 说明服务已经退出(守护脚本会负责重启),
                # 这里不需要也不应该杀任何进程。
                _wf=0
                echo "[$(date '+%Y-%m-%d %H:%M:%S')] watchdog: port ${_wd_port} unresponsive (no listening process)" >> "$GUARD_LOG" 2>/dev/null
                continue
            fi
            if [ -n "$_wd_pid" ] && [ "$_hung_pid" != "$_wd_pid" ]; then
                # 状态文件里的进程号与端口上的监听进程对不上: 状态已过期(来自上一次运行
                # 或另一个实例), 此时杀掉监听进程可能误伤无关的服务。
                _wf=0
                echo "[$(date '+%Y-%m-%d %H:%M:%S')] watchdog: port ${_wd_port} unresponsive but listener PID ${_hung_pid} != recorded PID ${_wd_pid}, skipped" >> "$GUARD_LOG" 2>/dev/null
                continue
            fi

            # 无响应: 先请求优雅重启(服务会先停掉所有虚拟机再退出, 退出码 5),
            # 该请求也失败时才强杀进程。
            if http_post "http://127.0.0.1:${_wd_port}/api/server/restart" 5; then
                _wf=0
                echo "[watchdog] server on port ${_wd_port} unresponsive; graceful restart requested"
                echo "[$(date '+%Y-%m-%d %H:%M:%S')] watchdog: server on port ${_wd_port} unresponsive; graceful restart requested" >> "$GUARD_LOG" 2>/dev/null
                sleep 5
                continue
            fi

            echo "[watchdog] server not responding, killing PID ${_hung_pid}"
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] watchdog: server on port ${_wd_port} unresponsive, killed PID ${_hung_pid}" >> "$GUARD_LOG" 2>/dev/null
            kill -9 "$_hung_pid" 2>/dev/null
            _wf=0
            sleep 3
        done
    ) &
    WATCHDOG_PID=$!
}

stop_watchdog() {
    if [ -n "$WATCHDOG_SENTINEL" ]; then
        rm -f "$WATCHDOG_SENTINEL"
        WATCHDOG_SENTINEL=""
    fi
    if [ -n "$WATCHDOG_PID" ]; then
        kill "$WATCHDOG_PID" 2>/dev/null
        wait "$WATCHDOG_PID" 2>/dev/null
        WATCHDOG_PID=""
    fi
}

# Ctrl+C / TERM -> clean exit, do NOT auto-restart
trap 'echo ""; echo "[INFO] Interrupted, stopping."; stop_watchdog; exit 130' INT TERM

while true; do
    RESTART_COUNT=$((RESTART_COUNT + 1))
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting server (attempt #${RESTART_COUNT})..."
    glog "starting server (attempt ${RESTART_COUNT}/${MAX_RESTARTS})"
    start_watchdog

    # 稳定运行标记: 服务器启动满 60 秒后会创建该文件, 守护脚本据此判断
    # "上一次运行是健康的" 并重置重启计数。
    UPTIME_MARK="${TMPDIR:-/tmp}/oc_uptime_ok.$$"
    rm -f "$UPTIME_MARK"
    export OC_UPTIME_MARKER="$UPTIME_MARK"

    # Foreground so the user sees the server output
    node server.js
    EXIT_CODE=$?

    RAN_LONG=0
    if [ -f "$UPTIME_MARK" ]; then RAN_LONG=1; fi
    rm -f "$UPTIME_MARK"

    stop_watchdog

    echo ""
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Server exited with code ${EXIT_CODE}."
    glog "server exited with code ${EXIT_CODE}"
    case "$EXIT_CODE" in
        0|3|4|5) : ;;
        *)
            echo "[WARNING] 服务异常退出 (崩溃, 或被看门狗判定为卡死后重启)。"
            echo "          详细记录: logs/guardian.log"
            glog "abnormal exit detected (code ${EXIT_CODE})"
            ;;
    esac

    # Exit code 3 = another instance is already running (single-instance guard).
    # Do NOT restart: otherwise we keep spawning a duplicate instance and the
    # watchdog may kill the instance that is actually serving.
    if [ "$EXIT_CODE" -eq 3 ]; then
        echo "[INFO] An OC Emulator instance is already running. Exiting."
        echo "       Please use the browser page of that instance."
        glog "another instance already running, exiting"
        exit 0
    fi

    if [ "$EXIT_CODE" -eq 130 ]; then
        echo "[INFO] Server stopped by user."
        exit 0
    fi

    # Exit code 4 = stop requested from the web control panel -> do not restart.
    if [ "$EXIT_CODE" -eq 4 ]; then
        echo "[INFO] Stop requested from the web control panel. Exiting."
        exit 0
    fi

    # Exit code 5 = restart requested from the web control panel -> restart at once,
    # and do not count it against the restart budget.
    if [ "$EXIT_CODE" -eq 5 ]; then
        echo "[INFO] Restart requested from the web control panel."
        RESTART_COUNT=0
        BACKOFF_SECONDS=2
        continue
    fi

    # 上一次运行是健康的 (服务器自己打了稳定运行标记) -> 重置重启计数与退避。
    # 否则长时间运行期间的偶发崩溃会累积消耗重启预算, 守护脚本最终放弃。
    if [ "$RAN_LONG" -eq 1 ]; then
        RESTART_COUNT=0
        BACKOFF_SECONDS=2
        echo "[INFO] Previous run was healthy, restart counter reset."
    fi

    if [ "$RESTART_COUNT" -ge "$MAX_RESTARTS" ]; then
        echo "[ERROR] Max restarts (${MAX_RESTARTS}) reached. Giving up."
        glog "max restarts (${MAX_RESTARTS}) reached, giving up"
        echo "服务反复启动失败, 已放弃自动重启。请查看 logs/guardian.log 后手动重新运行本脚本。"
        exit 1
    fi

    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Restarting in ${BACKOFF_SECONDS}s (attempt ${RESTART_COUNT}/${MAX_RESTARTS})..."
    echo ""
    sleep "$BACKOFF_SECONDS"

    # Exponential backoff (max 30s)
    BACKOFF_SECONDS=$((BACKOFF_SECONDS * 2))
    if [ "$BACKOFF_SECONDS" -gt 30 ]; then
        BACKOFF_SECONDS=30
    fi
done
