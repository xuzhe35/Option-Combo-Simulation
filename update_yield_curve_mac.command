#!/bin/zsh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

pause_if_interactive() {
    if [ -t 0 ] && [ "${OPTION_COMBO_NO_PAUSE:-0}" != "1" ]; then
        echo
        read -r "_unused?Press Enter to close..."
    fi
}

finish() {
    local exit_code="$1"
    pause_if_interactive
    exit "$exit_code"
}

read_ini_value() {
    local file="$1" section="$2" key="$3"
    [ -f "$file" ] || return 1
    awk -F= -v sec="$section" -v k="$key" '
        /^\[/ { gsub(/[\[\] ]/, ""); cur=$0; next }
        cur==sec && $1~"^[ \t]*"k"[ \t]*$" {
            sub(/^[^=]*=/, ""); gsub(/^[ \t]+|[ \t]+$/, "", $0); print; exit
        }
    ' "$file"
}

try_python_candidate() {
    local candidate="$1"
    [ -n "$candidate" ] && [ -x "$candidate" ] || return 1
    "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1 || return 1
    printf '%s\n' "$candidate"
}

resolve_python() {
    local candidate=""

    if candidate="$(try_python_candidate "${OPTION_COMBO_PYTHON:-}" 2>/dev/null)"; then
        printf '%s\n' "$candidate"
        return 0
    fi

    candidate="$(read_ini_value config.local.ini python executable 2>/dev/null || true)"
    if candidate="$(try_python_candidate "$candidate" 2>/dev/null)"; then
        printf '%s\n' "$candidate"
        return 0
    fi

    candidate="$(read_ini_value config.ini python executable 2>/dev/null || true)"
    if candidate="$(try_python_candidate "$candidate" 2>/dev/null)"; then
        printf '%s\n' "$candidate"
        return 0
    fi

    local vdir=""
    for vdir in .venv venv; do
        if candidate="$(try_python_candidate "$SCRIPT_DIR/$vdir/bin/python" 2>/dev/null)"; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    local command_name="" resolved=""
    for command_name in python3.14 python3.13 python3.12 python3.11 python3.10 python3.9 python3.8 python3 python; do
        resolved="$(command -v "$command_name" 2>/dev/null || true)"
        if candidate="$(try_python_candidate "$resolved" 2>/dev/null)"; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done

    echo 'Unable to resolve Python 3.8+.' >&2
    echo 'Set OPTION_COMBO_PYTHON, config.local.ini [python].executable, or create .venv.' >&2
    return 1
}

echo 'Option Combo Simulation - USD yield-curve updater'
if ! PYTHON_BIN="$(resolve_python)"; then
    finish 1
fi
echo "Python: $PYTHON_BIN"
echo

echo 'Checking official NY Fed SOFR and U.S. Treasury CMT data...'
"$PYTHON_BIN" -m yield_curve update "$@"
UPDATE_EXIT_CODE=$?

echo
if [ "$UPDATE_EXIT_CODE" -ne 0 ]; then
    echo "ERROR: yield-curve update failed (exit $UPDATE_EXIT_CODE)." >&2
    echo 'The updater never overwrites a prior complete snapshot with a failed download.' >&2
    echo
fi

echo 'Current local snapshot:'
"$PYTHON_BIN" -m yield_curve status
STATUS_EXIT_CODE=$?

echo
if [ "$UPDATE_EXIT_CODE" -eq 0 ] && [ "$STATUS_EXIT_CODE" -eq 0 ]; then
    echo 'Yield-curve maintenance completed successfully.'
    finish 0
fi
if [ "$STATUS_EXIT_CODE" -ne 0 ]; then
    echo 'ERROR: no usable local yield-curve snapshot is available.' >&2
fi
if [ "$UPDATE_EXIT_CODE" -ne 0 ]; then
    finish "$UPDATE_EXIT_CODE"
fi
finish "$STATUS_EXIT_CODE"
