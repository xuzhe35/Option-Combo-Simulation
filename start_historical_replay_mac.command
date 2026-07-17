#!/bin/bash
# Start the historical replay stack on macOS:
#   1. options chain service (external, swappable) if not already running
#   2. static frontend server on :8000
#   3. historical replay websocket backend on :8765
cd "$(dirname "$0")"

PYTHON_BIN="python3"
if [ -x ".venv/bin/python" ]; then
    PYTHON_BIN=".venv/bin/python"
fi

# Where the chain service lives is config, not knowledge this script owns:
# ask chain_service_config.py so config.ini and the env overrides stay the one
# source of truth. An empty dir means the service is remote and not ours to
# start. See config.ini [historical].
CHAIN_SERVICE_URL="$("$PYTHON_BIN" chain_service_config.py --url)"
CHAIN_SERVICE_DIR="$("$PYTHON_BIN" chain_service_config.py --dir)"

if curl -s -o /dev/null --max-time 2 "$CHAIN_SERVICE_URL/health"; then
    echo "Options chain service already running at $CHAIN_SERVICE_URL"
elif [ -z "$CHAIN_SERVICE_DIR" ]; then
    echo "WARNING: options chain service not reachable at $CHAIN_SERVICE_URL."
    echo "         It is configured as remote (chain_service_dir is empty), so"
    echo "         this script will not start it. Historical replay will fail"
    echo "         until that service answers."
elif [ -f "$CHAIN_SERVICE_DIR/chain_server.py" ]; then
    echo "Starting options chain service from $CHAIN_SERVICE_DIR"
    # Deliberately system python3, not our .venv: the chain service is a
    # separate project that brings its own dependencies.
    (cd "$CHAIN_SERVICE_DIR" && nohup python3 chain_server.py > /tmp/chain_service.log 2>&1 &)
    sleep 1
else
    echo "WARNING: options chain service not reachable at $CHAIN_SERVICE_URL"
    echo "         and no chain_server.py under: $CHAIN_SERVICE_DIR"
    echo "         Fix chain_service_dir in config.ini (or set"
    echo "         OPTION_COMBO_CHAIN_SERVICE_DIR), or blank it if the service"
    echo "         is remote. Historical replay will fail until it is running."
fi

"$PYTHON_BIN" -m http.server 8000 &
HTTP_PID=$!
"$PYTHON_BIN" historical_server.py &
WS_PID=$!

echo ""
echo "Started:"
echo "  - Frontend:  http://localhost:8000/index.html?entry=historical&marketDataMode=historical&lockMarketDataMode=1"
echo "  - Historical replay backend: ws://localhost:8765"
echo "  - Options chain service:     $CHAIN_SERVICE_URL"
echo ""
echo "Press Ctrl+C to stop the frontend + backend."

trap 'kill $HTTP_PID $WS_PID 2>/dev/null' EXIT
wait
