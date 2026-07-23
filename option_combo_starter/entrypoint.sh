#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/xuzhe35/Option-Combo-Simulation.git"
REPO_DIR="/app/Option-Combo-Simulation"
NEED_SETUP=false

if [ ! -d "$REPO_DIR/.git" ]; then
    echo "==> First run: cloning repo..."
    git clone "$REPO_URL" "$REPO_DIR"
    NEED_SETUP=true
else
    LOCAL_HEAD=$(git -C "$REPO_DIR" rev-parse HEAD)
    REMOTE_HEAD=$(git -C "$REPO_DIR" ls-remote origin HEAD | awk '{print $1}')

    if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
        echo "==> Upstream changed: fetching and resetting..."
        git -C "$REPO_DIR" fetch origin
        git -C "$REPO_DIR" reset --hard origin/main
        NEED_SETUP=true
    else
        echo "==> Repo up to date, skipping setup."
    fi
fi

if [ "$NEED_SETUP" = true ]; then
    # Replace config.ini
    echo "==> Copying config.ini..."
    cp /app/config.ini "$REPO_DIR/config.ini"

    # Apply env var overrides to config.ini
    apply_override() {
        local env_val="$1" section="$2" key="$3" file="$REPO_DIR/config.ini"
        if [ -n "$env_val" ]; then
            echo "==> Override: [$section] $key = $env_val"
            sed -i "s|^\($key\s*=\s*\).*|\1$env_val|" "$file"
        fi
    }

    apply_override "${TWS_HOST:-}" tws host
    apply_override "${TWS_PORT:-}" tws port
    apply_override "${TWS_CLIENT_ID:-}" tws client_id
    apply_override "${WS_HOST:-}" server ws_host
    apply_override "${WS_PORT:-}" server ws_port

    # Install dependencies
    echo "==> Installing pip dependencies..."
    pip install --no-cache-dir -r "$REPO_DIR/requirements-ib-bridge.txt"
fi

echo "==> Launching services..."
cd "$REPO_DIR"
exec bash start_option_combo.sh
