#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "==============================================="
echo "  OC Emulator - Web Control Panel v2.0"
echo "==============================================="
echo ""

# ------------------------------------------------------------
# Guardian log: records every start / crash exit / hung restart.
#   Lets you investigate afterwards even when the terminal output has scrolled
#   away or the window was closed.
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

# Termux / Android detection, reused by the Node, Git and battery steps.
# Termux has its own pkg manager: no sudo, and packages are "nodejs" / "git".
IS_TERMUX=false
case "$PREFIX" in
    *com.termux*) IS_TERMUX=true ;;
esac
if [ -n "$TERMUX_VERSION" ]; then IS_TERMUX=true; fi

# Termux ships two backends behind "pkg": apt (older) and pacman (newer).
# "-y" only means "assume yes" for apt; pacman reads it as "refresh the database"
# and still waits for a Y/n answer, which looks like a hang. Ask termux-tools which
# backend is active and build the confirmation flag accordingly.
TERMUX_BACKEND="apt"
if [ "$IS_TERMUX" = true ] && [ -r "$PREFIX/bin/termux-setup-package-manager" ]; then
    TERMUX_BACKEND="$(
        . "$PREFIX/bin/termux-setup-package-manager" >/dev/null 2>&1
        echo "${TERMUX_APP_PACKAGE_MANAGER:-apt}"
    )"
fi

# Run one install step with its full output visible, then report success or the
# exact exit code. Suppressing the package manager's progress and status made
# failures indistinguishable from a slow install.
run_install() {
    local label="$1"
    shift
    local code=0
    echo "[INFO] $label"
    if [ "$IS_TERMUX" = true ]; then
        # apt silently waits for its lock and for unseen conffile prompts, which
        # looks exactly like a hang. Say what to expect, warn about a busy apt,
        # and run non-interactively so no prompt can block the install.
        echo "       (downloads can take several minutes; if it never moves, check the network)"
        if command -v pgrep >/dev/null 2>&1 && pgrep -f 'apt|dpkg' >/dev/null 2>&1; then
            echo "[WARNING] Another apt/dpkg process is running; this step may wait for its lock."
        fi
        echo "       \$ DEBIAN_FRONTEND=noninteractive $*"
        DEBIAN_FRONTEND=noninteractive "$@" || code=$?
    else
        echo "       \$ $*"
        "$@" || code=$?
    fi
    if [ "$code" -eq 0 ]; then
        echo "[OK] $label"
        return 0
    fi
    echo "[FAIL] $label (exit code ${code})"
    if [ "$IS_TERMUX" = true ]; then
        echo "       If the network is slow or the mirror is stale, run 'pkg update' once and retry."
    fi
    return "$code"
}

# Install Termux packages with each phase printed. Calling "pkg" hides a mirror
# probe and an implicit "apt update" inside a single silent command, which is
# exactly what made a slow network look like a frozen terminal; apt / pacman are
# invoked here so the refresh and the install are separate, visible steps.
TERMUX_LISTS_FRESH=false
termux_install() {
    local label="$1"
    shift
    if [ "$TERMUX_LISTS_FRESH" != true ]; then
        case "$TERMUX_BACKEND" in
            pacman) run_install "Refreshing package lists" pacman -Sy ;;
            *) run_install "Refreshing package lists" apt update ;;
        esac || echo "[WARNING] Package list refresh failed; trying the install anyway."
        TERMUX_LISTS_FRESH=true
    fi
    case "$TERMUX_BACKEND" in
        pacman) run_install "$label" pacman -S --needed --noconfirm "$@" ;;
        *) run_install "$label" apt install -y "$@" ;;
    esac
}

install_node() {
    echo ""
    echo "Attempting to install Node.js..."
    echo ""

    OS_TYPE="$(uname -s)"
    INSTALL_SUCCESS=false

    case "$OS_TYPE" in
        Linux*)
            if [ "$IS_TERMUX" = true ]; then
                # Termux: pkg wraps apt, "nodejs" already ships npm
                if termux_install "Installing Node.js (Termux)" nodejs; then
                    INSTALL_SUCCESS=true
                else
                    # Empty or stale package lists answer "Unable to locate package";
                    # refresh once and retry before falling back to nvm.
                    echo "[INFO] Retrying after refreshing the package lists..."
                    TERMUX_LISTS_FRESH=false
                    if termux_install "Installing Node.js (Termux)" nodejs; then
                        INSTALL_SUCCESS=true
                    fi
                fi
            # Try package managers
            elif command -v apt-get >/dev/null 2>&1; then
                run_install "Updating apt package lists" sudo apt-get update \
                    && run_install "Installing Node.js via apt-get" sudo apt-get install -y nodejs npm \
                    && INSTALL_SUCCESS=true
            elif command -v yum >/dev/null 2>&1; then
                run_install "Installing Node.js via yum" sudo yum install -y nodejs npm \
                    && INSTALL_SUCCESS=true
            elif command -v dnf >/dev/null 2>&1; then
                run_install "Installing Node.js via dnf" sudo dnf install -y nodejs npm \
                    && INSTALL_SUCCESS=true
            elif command -v pacman >/dev/null 2>&1; then
                run_install "Installing Node.js via pacman" sudo pacman -S --noconfirm nodejs npm \
                    && INSTALL_SUCCESS=true
            elif command -v apk >/dev/null 2>&1; then
                run_install "Installing Node.js via apk" sudo apk add nodejs npm \
                    && INSTALL_SUCCESS=true
            else
                echo "No known package manager found."
            fi
            ;;
        Darwin*)
            if command -v brew >/dev/null 2>&1; then
                run_install "Installing Node.js via Homebrew" brew install node \
                    && INSTALL_SUCCESS=true
            elif command -v port >/dev/null 2>&1; then
                run_install "Installing Node.js via MacPorts" sudo port install nodejs20 \
                    && INSTALL_SUCCESS=true
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
            curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
        fi

        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
        nvm install --lts && nvm use --lts
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
# 1b. Termux / Android
#     The host battery is unreadable through sysfs there, so the
#     emulator uses the Termux API. Only the CLI package can be
#     installed here; the Termux:API app comes from F-Droid.
# ============================================================
if [ "$IS_TERMUX" = true ]; then
    if command -v termux-battery-status >/dev/null 2>&1; then
        echo "[OK] termux-api"
    else
        echo "[INFO] Termux detected, installing termux-api..."
        termux_install "Installing termux-api" termux-api
        if command -v termux-battery-status >/dev/null 2>&1; then
            echo "[OK] termux-api installed"
        else
            echo "[WARNING] termux-api could not be installed automatically."
            echo "          Run: pkg install termux-api"
            echo "          Battery values stay at 100% until it is available."
        fi
    fi
    if ! command -v termux-battery-status >/dev/null 2>&1; then
        echo "[INFO] Also install the Termux:API app, otherwise the battery cannot be read:"
        echo "       https://f-droid.org/packages/com.termux.api/"
    fi
fi

# ============================================================
# 1c. Git
#     Automatic updates run git pull; without it they fail.
#     A missing Git is only a warning: the emulator still starts.
# ============================================================
install_git() {
    if [ "$IS_TERMUX" = true ]; then
        termux_install "Installing Git (Termux)" git
    elif command -v apt-get >/dev/null 2>&1; then
        run_install "Updating apt package lists" sudo apt-get update \
            && run_install "Installing Git via apt-get" sudo apt-get install -y git
    elif command -v dnf >/dev/null 2>&1; then
        run_install "Installing Git via dnf" sudo dnf install -y git
    elif command -v yum >/dev/null 2>&1; then
        run_install "Installing Git via yum" sudo yum install -y git
    elif command -v pacman >/dev/null 2>&1; then
        run_install "Installing Git via pacman" sudo pacman -S --noconfirm git
    elif command -v apk >/dev/null 2>&1; then
        run_install "Installing Git via apk" sudo apk add git
    elif command -v brew >/dev/null 2>&1; then
        run_install "Installing Git via Homebrew" brew install git
    elif command -v port >/dev/null 2>&1; then
        run_install "Installing Git via MacPorts" sudo port install git
    else
        echo "[FAIL] No supported package manager found for Git."
        return 1
    fi
}

if command -v git >/dev/null 2>&1; then
    echo "[OK] Git: $(git --version 2>/dev/null)"
else
    echo "[WARNING] Git not found; automatic updates will fail."
    install_git
    if command -v git >/dev/null 2>&1; then
        echo "[OK] Git installed: $(git --version 2>/dev/null)"
    else
        echo "[WARNING] Could not install Git automatically."
        echo "          Install it manually: https://git-scm.com/downloads"
        echo "          The emulator still starts; only automatic updates are skipped."
    fi
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
# The server writes its actual listening port and its own PID to these two files
# at startup; if the configured port (8080) is taken it auto-switches to 8081 and
# so on, and a watchdog that only knew 8080 would watch the wrong port -- leaving
# a genuinely hung server unmanaged. Always trust the values written to the files.
WATCHDOG_PORT_FILE="$(pwd)/cache/.server-port"
WATCHDOG_PID_FILE="$(pwd)/cache/.server-pid"
WATCHDOG_INTERVAL=30
WATCHDOG_TIMEOUT=10
# Only N consecutive failed probes count as a hang (probes are WATCHDOG_INTERVAL seconds apart).
WATCHDOG_MAX_FAILS=3
# The first N rounds after startup are not judged: the port may not be listening yet and the state files may not be written.
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

# HTTP probe: curl first, wget as fallback.
# When neither exists, start_watchdog disables hang detection outright -- otherwise
# the health check would always fail and repeatedly kill a healthy server.
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
        _wf=0     # consecutive failed probes
        _wr=0     # rounds elapsed (for the startup grace period)
        while true; do
            sleep "$WATCHDOG_INTERVAL"
            # Main loop finished -> watchdog stops too
            [ -f "$WATCHDOG_SENTINEL" ] || exit 0
            _wr=$((_wr + 1))

            # Port and PID come from the actual values the server wrote; when a file
            # is missing or invalid this round makes no decision at all:
            # a missing state may just be a failed write, or a restart gap, and
            # restarting then would only hurt a process that is working fine.
            # Better to miss one round than to kill a healthy server.
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

            # Startup grace period: the server may still be coming up (disk image
            # sync and similar IO block the event loop), so probe failures during
            # this window do not count as a hang.
            if [ "$_wr" -le "$WATCHDOG_WARMUP_ROUNDS" ]; then
                _wf=0
                continue
            fi

            # Act only after consecutive failures: the server may just be briefly
            # busy (disk operations block the event loop for tens of seconds), and
            # killing on a single failure would hit a normally running server.
            _wf=$((_wf + 1))
            if [ "$_wf" -lt "$WATCHDOG_MAX_FAILS" ]; then
                continue
            fi

            # Several failures in a row: re-check once right before acting, so an
            # isolated probe failure is not treated as a hang.
            if http_probe "http://127.0.0.1:${_wd_port}/api/version" "$WATCHDOG_TIMEOUT"; then
                _wf=0
                continue
            fi

            _hung_pid="$(find_pid_on_port "$_wd_port")"
            if [ -z "$_hung_pid" ]; then
                # No listener on the port at all: the server already exited (the
                # guardian handles restarts), so nothing should or needs to be killed.
                _wf=0
                echo "[$(date '+%Y-%m-%d %H:%M:%S')] watchdog: port ${_wd_port} unresponsive (no listening process)" >> "$GUARD_LOG" 2>/dev/null
                continue
            fi
            if [ -n "$_wd_pid" ] && [ "$_hung_pid" != "$_wd_pid" ]; then
                # The PID in the state file does not match the listener on the port:
                # the state is stale (from a previous run or another instance), and
                # killing the listener could hit an unrelated service.
                _wf=0
                echo "[$(date '+%Y-%m-%d %H:%M:%S')] watchdog: port ${_wd_port} unresponsive but listener PID ${_hung_pid} != recorded PID ${_wd_pid}, skipped" >> "$GUARD_LOG" 2>/dev/null
                continue
            fi

            # Unresponsive: ask for a graceful restart first (the server stops all
            # VMs and exits with code 5), and only force-kill if that request fails.
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

    # Uptime marker: the server creates this file after running for 60 seconds;
    # the guardian uses it to tell that "the last run was healthy" and resets the
    # restart counter.
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

    # The previous run was healthy (the server set the uptime marker) -> reset the
    # restart counter and backoff. Otherwise occasional crashes during long runs
    # would eat the restart budget until the guardian gives up.
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
