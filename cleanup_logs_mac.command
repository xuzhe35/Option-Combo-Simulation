#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

resolve_python() {
    if [ -n "${OPTION_COMBO_PYTHON:-}" ] && [ -x "$OPTION_COMBO_PYTHON" ]; then
        echo "$OPTION_COMBO_PYTHON"
        return
    fi

    for vdir in .venv venv; do
        if [ -x "$SCRIPT_DIR/$vdir/bin/python" ]; then
            echo "$SCRIPT_DIR/$vdir/bin/python"
            return
        fi
    done

    for cmd in python3.14 python3.13 python3.12 python3.11 python3.10 python3 python; do
        if command -v "$cmd" >/dev/null 2>&1; then
            command -v "$cmd"
            return
        fi
    done

    echo "Unable to resolve Python. Set OPTION_COMBO_PYTHON or install Python 3." >&2
    exit 1
}

PYTHON_BIN="$(resolve_python)"
"$PYTHON_BIN" "$SCRIPT_DIR/scripts/cleanup_runtime_logs.py" "$@"
