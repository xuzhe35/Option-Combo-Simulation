#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

AUTO_SCOPE=0
if [ "${1:-}" = "--auto-scope" ]; then
    AUTO_SCOPE=1
    shift
fi

pause_if_interactive() {
    if [ -t 0 ] && [ "${OPTION_COMBO_NO_PAUSE:-0}" != "1" ]; then
        echo
        read -r -p 'Press Enter to close...' _unused
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

load_cme_credentials() {
    local value=""
    if [ -z "${CME_API_ID:-}" ]; then
        value="$(read_ini_value config.local.ini cme api_id 2>/dev/null || true)"
        if [ -n "$value" ]; then export CME_API_ID="$value"; fi
    fi
    if [ -z "${CME_API_SECRET:-}" ]; then
        value="$(read_ini_value config.local.ini cme api_secret 2>/dev/null || true)"
        if [ -n "$value" ]; then export CME_API_SECRET="$value"; fi
    fi
    if [ -z "${CME_ACCESS_TOKEN:-}" ]; then
        value="$(read_ini_value config.local.ini cme access_token 2>/dev/null || true)"
        if [ -n "$value" ]; then export CME_ACCESS_TOKEN="$value"; fi
    fi
}

is_nyse_only_or_check() {
    local arg=""
    for arg in "$@"; do
        case "$arg" in
            --nyse-only|--check) return 0 ;;
        esac
    done
    return 1
}

has_check_argument() {
    local arg=""
    for arg in "$@"; do
        if [ "$arg" = "--check" ]; then
            return 0
        fi
    done
    return 1
}

has_help_argument() {
    local arg=""
    for arg in "$@"; do
        case "$arg" in
            -h|--help) return 0 ;;
        esac
    done
    return 1
}

echo 'Option Combo Simulation - official exchange-calendar updater'
if ! PYTHON_BIN="$(resolve_python)"; then
    finish 1
fi
echo "Python: $PYTHON_BIN"
echo

if has_help_argument "$@"; then
    "$PYTHON_BIN" "$SCRIPT_DIR/scripts/sync_official_exchange_calendars.py" "$@"
    finish $?
fi

load_cme_credentials
if [ "$AUTO_SCOPE" -eq 1 ] && ! is_nyse_only_or_check "$@"; then
    if [ -z "${CME_API_ID:-}" ] && [ -z "${CME_ACCESS_TOKEN:-}" ]; then
        echo 'No CME credentials were found; automatically refreshing NYSE only.' >&2
        echo 'Existing CME/NYMEX/COMEX entries will be preserved with their original timestamps.' >&2
        echo
        set -- --nyse-only "$@"
    fi
fi
if ! is_nyse_only_or_check "$@"; then
    if [ -z "${CME_API_ID:-}" ] && [ -z "${CME_ACCESS_TOKEN:-}" ]; then
        echo 'Note: no CME credentials were found.' >&2
        echo 'The full update requires config.local.ini [cme] credentials.' >&2
        echo 'For an explicit NYSE-only refresh, rerun with --nyse-only.' >&2
        echo
    fi
fi

echo 'Downloading and validating official NYSE/CME exchange calendars...'
"$PYTHON_BIN" "$SCRIPT_DIR/scripts/sync_official_exchange_calendars.py" "$@"
SYNC_EXIT_CODE=$?

echo
if [ "$SYNC_EXIT_CODE" -eq 0 ]; then
    if has_check_argument "$@"; then
        echo 'Exchange-calendar validation completed successfully.'
    else
        echo 'Exchange-calendar maintenance completed successfully.'
        echo 'Hard-refresh open browser pages before relying on the new calendar snapshot.'
    fi
    finish 0
fi

echo "ERROR: exchange-calendar update failed (exit $SYNC_EXIT_CODE)." >&2
echo 'Existing generated calendar files were left unchanged.' >&2
finish "$SYNC_EXIT_CODE"
