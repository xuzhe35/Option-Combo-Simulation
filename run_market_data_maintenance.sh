#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

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

YIELD_IF_NEEDED=0
NYSE_ONLY=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --yield-if-needed)
            YIELD_IF_NEEDED=1
            ;;
        --nyse-only)
            NYSE_ONLY=1
            ;;
        -h|--help)
            echo 'Usage: ./run_market_data_maintenance.sh [--yield-if-needed] [--nyse-only]'
            echo
            echo 'Runs yield-curve maintenance first, then exchange-calendar maintenance,'
            echo 'then re-stamps the browser cache-busting tags for whatever was regenerated.'
            echo 'The calendar step is skipped if the yield-curve step fails.'
            finish 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            finish 2
            ;;
    esac
    shift
done

echo 'Option Combo Simulation - market-data maintenance'
echo
echo '[1/3] Updating the USD yield curve...'
if [ "$YIELD_IF_NEEDED" -eq 1 ]; then
    OPTION_COMBO_NO_PAUSE=1 "$SCRIPT_DIR/update_yield_curve.sh" --if-needed
else
    OPTION_COMBO_NO_PAUSE=1 "$SCRIPT_DIR/update_yield_curve.sh"
fi
YIELD_EXIT_CODE=$?
if [ "$YIELD_EXIT_CODE" -ne 0 ]; then
    echo
    echo "ERROR: yield-curve maintenance failed (exit $YIELD_EXIT_CODE)." >&2
    echo 'Exchange-calendar maintenance was not started.' >&2
    finish "$YIELD_EXIT_CODE"
fi

echo
echo '[2/3] Updating official exchange calendars...'
if [ "$NYSE_ONLY" -eq 1 ]; then
    OPTION_COMBO_NO_PAUSE=1 "$SCRIPT_DIR/sync_exchange_calendars.sh" --nyse-only
else
    OPTION_COMBO_NO_PAUSE=1 "$SCRIPT_DIR/sync_exchange_calendars.sh" --auto-scope
fi
CALENDAR_EXIT_CODE=$?
if [ "$CALENDAR_EXIT_CODE" -ne 0 ]; then
    echo
    echo "ERROR: exchange-calendar maintenance failed (exit $CALENDAR_EXIT_CODE)." >&2
    finish "$CALENDAR_EXIT_CODE"
fi

echo
echo '[3/3] Re-stamping browser cache-busting tags...'
# The calendar step rewrites js/official_exchange_calendars.generated.js. Without
# this, browsers keep the previous file under the old ?v= tag -- the exact
# failure commit 94ed93b had to clean up by hand.
python3 "$SCRIPT_DIR/scripts/stamp_asset_versions.py"
STAMP_EXIT_CODE=$?
if [ "$STAMP_EXIT_CODE" -ne 0 ]; then
    echo
    echo "ERROR: asset version stamping failed (exit $STAMP_EXIT_CODE)." >&2
    finish "$STAMP_EXIT_CODE"
fi

echo
echo 'All market-data maintenance completed successfully.'
finish 0
