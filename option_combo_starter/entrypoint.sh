#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/xuzhe35/Option-Combo-Simulation.git"
REPO_DIR="${OPTION_COMBO_REPO_DIR:-/app/Option-Combo-Simulation}"
CONFIG_SOURCE="${OPTION_COMBO_CONFIG_SOURCE:-/app/config.ini}"
CONFIG_OVERLAY_PATH="${OPTION_COMBO_CONFIG_OVERLAY_PATH:-/app/config_overlay.py}"
SETUP_MARKER="${OPTION_COMBO_SETUP_MARKER:-/app/.option_combo_setup_head}"
SUPERVISOR_PATH="${OPTION_COMBO_SUPERVISOR_PATH:-/app/supervisor.py}"
GIT_NETWORK_TIMEOUT_SECONDS="${OPTION_COMBO_GIT_NETWORK_TIMEOUT_SECONDS:-60}"
NEED_SETUP=false
LOCAL_HEAD=""

if ! [[ "$GIT_NETWORK_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
    echo "WARNING: Invalid OPTION_COMBO_GIT_NETWORK_TIMEOUT_SECONDS; using 60 seconds." >&2
    GIT_NETWORK_TIMEOUT_SECONDS=60
fi

if ! command -v timeout >/dev/null 2>&1; then
    echo "ERROR: The container requires the GNU timeout command for bounded Git network operations." >&2
    exit 2
fi

run_git_network() {
    timeout \
        --signal=TERM \
        --kill-after=5s \
        "${GIT_NETWORK_TIMEOUT_SECONDS}s" \
        git "$@"
}

CLONE_TEMP_DIR=""
cleanup_clone_temp() {
    if [ -n "$CLONE_TEMP_DIR" ] && [ -d "$CLONE_TEMP_DIR" ]; then
        rm -r -- "$CLONE_TEMP_DIR" || {
            echo "WARNING: Unable to remove incomplete clone staging directory: $CLONE_TEMP_DIR" >&2
        }
    fi
}

if [ ! -d "$REPO_DIR/.git" ]; then
    echo "==> First run: cloning repo..."
    if [ -e "$REPO_DIR" ]; then
        if [ -d "$REPO_DIR" ] && rmdir -- "$REPO_DIR"; then
            :
        else
            echo "ERROR: Clone target exists but is not an empty directory: $REPO_DIR" >&2
            exit 1
        fi
    fi
    CLONE_TEMP_DIR="$(mktemp -d "${REPO_DIR}.clone.XXXXXX")"
    trap cleanup_clone_temp EXIT
    if run_git_network clone "$REPO_URL" "$CLONE_TEMP_DIR"; then
        mv "$CLONE_TEMP_DIR" "$REPO_DIR"
        CLONE_TEMP_DIR=""
        trap - EXIT
        NEED_SETUP=true
    else
        clone_status=$?
        echo "ERROR: Initial repository clone failed or exceeded ${GIT_NETWORK_TIMEOUT_SECONDS}s." >&2
        exit "$clone_status"
    fi
fi

if ! LOCAL_HEAD="$(git -C "$REPO_DIR" rev-parse HEAD)"; then
    echo "ERROR: Existing repository checkout is not usable: $REPO_DIR" >&2
    exit 1
fi

if [ "$NEED_SETUP" = false ]; then
    REMOTE_HEAD=""
    if REMOTE_HEAD="$(run_git_network -C "$REPO_DIR" ls-remote origin HEAD | awk 'NR == 1 {print $1}')"; then
        if [ -z "$REMOTE_HEAD" ]; then
            echo "WARNING: Remote HEAD was empty; using existing local checkout."
        elif [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
            echo "==> Upstream changed: fetching and resetting..."
            if run_git_network -C "$REPO_DIR" fetch origin; then
                if git -C "$REPO_DIR" reset --hard origin/main; then
                    LOCAL_HEAD="$(git -C "$REPO_DIR" rev-parse HEAD)"
                    NEED_SETUP=true
                else
                    echo "WARNING: Upstream reset failed; using existing local checkout."
                fi
            else
                echo "WARNING: Upstream fetch failed or exceeded ${GIT_NETWORK_TIMEOUT_SECONDS}s; using existing local checkout."
            fi
        else
            echo "==> Repo up to date."
        fi
    else
        echo "WARNING: Remote probe failed or exceeded ${GIT_NETWORK_TIMEOUT_SECONDS}s; using existing local checkout."
    fi
fi

MARKED_SETUP_HEAD=""
if [ -f "$SETUP_MARKER" ]; then
    IFS= read -r MARKED_SETUP_HEAD < "$SETUP_MARKER" || true
fi
if [ "$MARKED_SETUP_HEAD" != "$LOCAL_HEAD" ]; then
    echo "==> Runtime setup is missing or belongs to another revision."
    NEED_SETUP=true
fi

if [ "$NEED_SETUP" = false ]; then
    echo "==> Runtime setup is current, skipping setup."
else
    # A previous completion marker must not survive an interrupted rerun,
    # including the rare case where a fresh checkout resolves to the same HEAD.
    rm -f -- "$SETUP_MARKER"

    # Keep the freshly cloned upstream config and atomically overlay only the
    # settings owned by this starter.
    echo "==> Applying starter configuration..."
    python3 "$CONFIG_OVERLAY_PATH" \
        --target "$REPO_DIR/config.ini" \
        --defaults "$CONFIG_SOURCE"

    # Install dependencies
    echo "==> Installing pip dependencies..."
    pip install --no-cache-dir -r "$REPO_DIR/requirements-ib-bridge.txt"

    # Record completion only after every setup step succeeds. An atomically
    # replaced temporary file keeps readers from observing a partial marker.
    MARKER_TEMP="${SETUP_MARKER}.tmp"
    printf '%s\n' "$LOCAL_HEAD" > "$MARKER_TEMP"
    mv "$MARKER_TEMP" "$SETUP_MARKER"
fi

echo "==> Launching services..."
exec python3 "$SUPERVISOR_PATH" --repo-dir "$REPO_DIR"
