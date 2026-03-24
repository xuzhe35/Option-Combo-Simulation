#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

REQ_FILE="$SCRIPT_DIR/requirements-ib-bridge.txt"

if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
else
    echo "Python not found. Please install Python 3 first."
    exit 1
fi

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
