#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
else
    echo "Python not found. Please install Python 3 first."
    exit 1
fi

HTTP_LOG="$SCRIPT_DIR/http_server.log"
IB_LOG="$SCRIPT_DIR/ib_server.log"

"$PYTHON_BIN" -m http.server 8000 >>"$HTTP_LOG" 2>&1 &
HTTP_PID=$!

"$PYTHON_BIN" ib_server.py >>"$IB_LOG" 2>&1 &
IB_PID=$!

cleanup() {
    echo
    echo "Stopping services..."
    kill "$HTTP_PID" "$IB_PID" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

echo "Started:"
echo "  - Frontend: http://localhost:8000/index.html"
echo "  - IB bridge: ws://localhost:8765"
echo
echo "Logs:"
echo "  - $HTTP_LOG"
echo "  - $IB_LOG"
echo
echo "Press Ctrl+C to stop both services."

wait "$HTTP_PID" "$IB_PID"
