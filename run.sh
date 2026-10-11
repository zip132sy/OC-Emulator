#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "==============================================="
echo "  OC Emulator - Web Control Panel v2.0"
echo "==============================================="
echo ""

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
# 3. Auto update (enabled by default; toggle in the web settings panel)
#    Pull the latest version from the remote before starting.
# ============================================================
AUTO_UPDATE="on"
if [ -f settings.json ]; then
    AUTO_UPDATE=$(node -e "try{const s=JSON.parse(require('fs').readFileSync('settings.json','utf8'));process.stdout.write(s.autoUpdate===false?'off':'on')}catch(e){process.stdout.write('on')}" 2>/dev/null)
fi
[ -z "$AUTO_UPDATE" ] && AUTO_UPDATE="on"

if [ "$AUTO_UPDATE" = "off" ]; then
    echo "[INFO] Auto update is OFF (enable it in the web settings panel)."
elif [ ! -d .git ]; then
    echo "[INFO] Not a git repository, skipping auto update."
elif ! command -v git >/dev/null 2>&1; then
    echo "[INFO] git not found, skipping auto update."
else
    echo "[INFO] Checking for updates..."
    if git pull --ff-only --quiet; then
        echo "[OK] Update check finished."
    elif git pull --ff-only --quiet github main; then
        echo "[OK] Update check finished."
    else
        echo "[WARNING] Auto update failed (ignored, continuing)."
    fi
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
WATCHDOG_PORT=8080
WATCHDOG_INTERVAL=30
WATCHDOG_TIMEOUT=10

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

# Background watchdog: health-check the server periodically and force-kill it
# if it stops responding (the main loop is responsible for restarting it).
# It exits by itself once the sentinel file is removed.
start_watchdog() {
    WATCHDOG_SENTINEL="$(mktemp -t oc_watchdog.XXXXXX 2>/dev/null || echo "/tmp/oc_watchdog.$$")"
    (
        while true; do
            sleep "$WATCHDOG_INTERVAL"
            # Main loop finished -> watchdog stops too
            [ -f "$WATCHDOG_SENTINEL" ] || exit 0
            if ! curl -fsS --max-time "$WATCHDOG_TIMEOUT" \
                 "http://127.0.0.1:${WATCHDOG_PORT}/api/version" >/dev/null 2>&1; then
                _hung_pid="$(find_pid_on_port "$WATCHDOG_PORT")"
                if [ -n "$_hung_pid" ]; then
                    echo "[watchdog] server not responding, killing PID ${_hung_pid}"
                    kill -9 "$_hung_pid" 2>/dev/null
                fi
                exit 0
            fi
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

    # Exit code 3 = another instance is already running (single-instance guard).
    # Do NOT restart: otherwise we keep spawning a duplicate instance and the
    # watchdog may kill the instance that is actually serving.
    if [ "$EXIT_CODE" -eq 3 ]; then
        echo "[INFO] An OC Emulator instance is already running. Exiting."
        echo "       Please use the browser page of that instance."
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
