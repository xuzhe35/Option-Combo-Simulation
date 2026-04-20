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

python_meets_minimum_version() {
    local candidate="$1"
    "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}

emit_python_version_error() {
    echo "ERROR: Python 3.10 or newer is required for ib_async." >&2
    echo "Set OPTION_COMBO_PYTHON, create config.local.ini [python].executable, or install Python 3.10+." >&2
    exit 1
}

try_python_candidate() {
    local candidate="$1"
    [ -n "$candidate" ] || return 1
    [ -x "$candidate" ] || return 1
    python_meets_minimum_version "$candidate" || return 2
    echo "$candidate"
    return 0
}

try_python_command() {
    local cmd="$1" resolved=""
    resolved="$(command -v "$cmd" 2>/dev/null || true)"
    [ -n "$resolved" ] || return 1
    try_python_candidate "$resolved"
}

resolve_python() {
    local resolved=""
    local saw_old_python=0

    if [ -n "${OPTION_COMBO_PYTHON:-}" ] && [ -x "$OPTION_COMBO_PYTHON" ]; then
        if resolved="$(try_python_candidate "$OPTION_COMBO_PYTHON")"; then
            echo "$resolved"
            return
        fi
        saw_old_python=1
    fi

    local p
    p="$(read_ini_value config.local.ini python executable 2>/dev/null || true)"
    if [ -n "$p" ] && [ -x "$p" ]; then
        if resolved="$(try_python_candidate "$p")"; then
            echo "$resolved"
            return
        fi
        saw_old_python=1
    fi

    p="$(read_ini_value config.ini python executable 2>/dev/null || true)"
    if [ -n "$p" ] && [ -x "$p" ]; then
        if resolved="$(try_python_candidate "$p")"; then
            echo "$resolved"
            return
        fi
        saw_old_python=1
    fi

    for vdir in .venv venv; do
        if [ -x "$SCRIPT_DIR/$vdir/bin/python" ]; then
            if resolved="$(try_python_candidate "$SCRIPT_DIR/$vdir/bin/python")"; then
                echo "$resolved"
                return
            fi
            saw_old_python=1
        fi
    done

    for cmd in python3.14 python3.13 python3.12 python3.11 python3.10 python3 python; do
        if resolved="$(try_python_command "$cmd")"; then
            echo "$resolved"
            return
        fi
        if command -v "$cmd" >/dev/null 2>&1; then
            saw_old_python=1
        fi
    done

    if [ "$saw_old_python" -eq 1 ]; then
        emit_python_version_error
    fi

    echo "ERROR: Unable to resolve a Python executable." >&2
    echo "Set OPTION_COMBO_PYTHON, create config.local.ini [python].executable, or install Python 3.10+." >&2
    exit 1
}

PYTHON="$(resolve_python)"

"$PYTHON" -m http.server 8000 &
HTTP_PID=$!

"$PYTHON" ib_server.py &
IB_PID=$!

echo "Started:"
echo "  - Frontend: http://localhost:8000/index.html?entry=live&marketDataMode=live&lockMarketDataMode=1"
echo "  - IB bridge: ws://localhost:8765"
echo
echo "Python: $PYTHON"
echo "PIDs:   http=$HTTP_PID  ib_server=$IB_PID"

trap 'kill $HTTP_PID $IB_PID 2>/dev/null; wait' INT TERM
wait
