#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

REQ_FILE="$SCRIPT_DIR/requirements-ib-bridge.txt"

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
    echo "Python 3.10 or newer is required for ib_async."
    echo "Set OPTION_COMBO_PYTHON, config.local.ini [python].executable, or install Python 3.10+."
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

    echo "Python not found. Set OPTION_COMBO_PYTHON, config.local.ini [python].executable, or install Python 3.10+."
    exit 1
}

PYTHON_BIN="$(resolve_python)"

if [ ! -f "$REQ_FILE" ]; then
    echo "Missing requirements file: $REQ_FILE"
    exit 1
fi

if ! "$PYTHON_BIN" -m pip --version >/dev/null 2>&1; then
    echo "pip not found for $PYTHON_BIN. Trying ensurepip..."
    "$PYTHON_BIN" -m ensurepip --upgrade
fi

if "$PYTHON_BIN" -c "import sys; raise SystemExit(0 if sys.prefix != sys.base_prefix else 1)"; then
    PIP_ARGS=(install --upgrade -r "$REQ_FILE")
else
    PIP_ARGS=(install --user --upgrade -r "$REQ_FILE")
fi

echo "Using Python: $("$PYTHON_BIN" -c 'import sys; print(sys.executable)')"
echo "Installing IB bridge dependencies from $REQ_FILE"

"$PYTHON_BIN" -m pip "${PIP_ARGS[@]}"

echo
echo "Installed:"
echo "  - ib_async"
echo "  - websockets"
