#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ---------------------------------------------------------------------------
# Resolve Python executable (mirrors powershell_scripts/python_launcher_common.ps1)
# Priority: OPTION_COMBO_PYTHON > config.local.ini > config.ini > .venv > venv > PATH
# ---------------------------------------------------------------------------
read_ini_value() {
    local file="$1" section="$2" key="$3"
    [ -f "$file" ] || return 1
    awk -F= -v sec="$section" -v k="$key" '
        /^\[/ { gsub(/[\[\] ]/, ""); cur=$0 }
        cur==sec && $1~"^[ \t]*"k"[ \t]*$" { gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit }
    ' "$file"
}

resolve_python() {
    # 1) Environment variable
    if [ -n "${OPTION_COMBO_PYTHON:-}" ] && [ -x "$OPTION_COMBO_PYTHON" ]; then
        echo "$OPTION_COMBO_PYTHON"; return
    fi

    # 2) config.local.ini [python].executable
    local p
    p="$(read_ini_value config.local.ini python executable 2>/dev/null || true)"
    if [ -n "$p" ] && [ -x "$p" ]; then echo "$p"; return; fi

    # 3) config.ini [python].executable
    p="$(read_ini_value config.ini python executable 2>/dev/null || true)"
    if [ -n "$p" ] && [ -x "$p" ]; then echo "$p"; return; fi

    # 4) Virtual environments
    for vdir in .venv venv; do
        if [ -x "$SCRIPT_DIR/$vdir/bin/python" ]; then
            echo "$SCRIPT_DIR/$vdir/bin/python"; return
        fi
    done

    # 5) PATH lookup
    for cmd in python3 python; do
        if command -v "$cmd" >/dev/null 2>&1; then
            command -v "$cmd"; return
        fi
    done

    echo "ERROR: Unable to resolve a Python executable." >&2
    echo "Set OPTION_COMBO_PYTHON, create config.local.ini [python].executable, or install Python." >&2
    exit 1
}

PYTHON="$(resolve_python)"

# ---------------------------------------------------------------------------
# Start services
# ---------------------------------------------------------------------------
"$PYTHON" -m http.server 8000 &
HTTP_PID=$!

"$PYTHON" ib_server.py &
IB_PID=$!

echo "Started:"
echo "  - Frontend: http://localhost:8000/index.html?entry=live&marketDataMode=live&lockMarketDataMode=1"
echo "  - IB bridge: ws://localhost:8765"
echo ""
echo "Python: $PYTHON"
echo "PIDs:   http=$HTTP_PID  ib_server=$IB_PID"

# Keep script alive; forward SIGTERM/SIGINT to children
trap 'kill $HTTP_PID $IB_PID 2>/dev/null; wait' INT TERM
wait
