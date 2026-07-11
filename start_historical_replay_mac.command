#!/bin/bash
# Start the historical replay stack on macOS:
#   1. options chain service (shared, Options DB workspace) if not running
#   2. static frontend server on :8000
#   3. historical replay websocket backend on :8765
cd "$(dirname "$0")"

CHAIN_SERVICE_URL="http://127.0.0.1:8750"
CHAIN_SERVICE_DIR="$(cd "../../Options DB/chain_service" 2>/dev/null && pwd)"

PYTHON_BIN="python3"
if [ -x ".venv/bin/python" ]; then
    PYTHON_BIN=".venv/bin/python"
fi

if curl -s -o /dev/null --max-time 2 "$CHAIN_SERVICE_URL/health"; then
    echo "Options chain service already running at $CHAIN_SERVICE_URL"
elif [ -n "$CHAIN_SERVICE_DIR" ] && [ -f "$CHAIN_SERVICE_DIR/chain_server.py" ]; then
    echo "Starting options chain service from $CHAIN_SERVICE_DIR"
    (cd "$CHAIN_SERVICE_DIR" && nohup python3 chain_server.py > /tmp/chain_service.log 2>&1 &)
    sleep 1
else
    echo "WARNING: options chain service not reachable at $CHAIN_SERVICE_URL"
    echo "         and chain_server.py not found. Historical replay will fail"
    echo "         until you start it: Options DB/chain_service/chain_server.py"
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
