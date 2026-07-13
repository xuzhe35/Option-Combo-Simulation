#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Minimal [section] key reader for the gitignored local secrets file. Mirrors
# read_ini_value in start_option_combo_mac.command, but keeps any '=' inside
# the value (OAuth secrets/tokens can contain it).
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

# Load CME OAuth credentials for the full sync from config.local.ini [cme]
# WITHOUT overriding anything the caller already exported (a scheduler can
# inject secrets via the environment instead). Missing credentials simply let
# the Python script fail closed, or honor an explicit --nyse-only.
# Uses explicit if/fi (not `test && export`) so an empty value does not make
# the function return non-zero under `set -e`.
load_cme_credentials() {
    local value
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
    return 0
}

warn_if_no_credentials() {
    local arg
    for arg in "$@"; do
        case "$arg" in
            --nyse-only|--check) return 0 ;;
        esac
    done
    if [ -z "${CME_API_ID:-}" ] && [ -z "${CME_ACCESS_TOKEN:-}" ]; then
        echo "Note: no CME credentials found (config.local.ini [cme] or CME_API_ID/SECRET env)." >&2
        echo "      The full sync needs them. Copy config.local.ini.example -> config.local.ini" >&2
        echo "      and fill [cme], or pass --nyse-only to refresh NYSE only." >&2
    fi
    return 0
}

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

load_cme_credentials
warn_if_no_credentials "$@"
PYTHON_BIN="$(resolve_python)"
"$PYTHON_BIN" "$SCRIPT_DIR/scripts/sync_official_exchange_calendars.py" "$@"
