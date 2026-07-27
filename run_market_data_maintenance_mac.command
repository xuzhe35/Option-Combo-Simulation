#!/bin/zsh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

OPTION_COMBO_NO_PAUSE=1 "$SCRIPT_DIR/run_market_data_maintenance.sh" "$@"
EXIT_CODE=$?

if [ -t 0 ] && [ "${OPTION_COMBO_NO_PAUSE:-0}" != "1" ]; then
    echo
    read -r "_unused?Press Enter to close..."
fi

exit "$EXIT_CODE"
