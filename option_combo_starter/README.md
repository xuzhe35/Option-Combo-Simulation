# Option Combo Starter (Docker)

Docker wrapper for [Option-Combo-Simulation](https://github.com/xuzhe35/Option-Combo-Simulation). Builds an image that, at container runtime, clones the upstream repo, applies configuration, installs dependencies, and launches the IB bridge + web UI.

## What the Container Does

1. **Git clone** the upstream repo (first run only)
2. **Replace `config.ini`** with the one bundled in this image
3. **Copy `start_option_combo.sh`** into the repo if it doesn't exist there (the upstream repo only has `start_option_combo_mac.command`; this is a Linux-compatible replacement from an unmerged branch)
4. **Apply env var overrides** for TWS and server settings (optional)
5. **`pip install`** from `requirements-ib-bridge.txt`
6. **Launch** via `start_option_combo.sh` — starts `ib_server.py` (WebSocket bridge) and `python3 -m http.server 8000` (web UI)

## Startup Behavior

| Scenario | What happens |
|---|---|
| **New container** (first run) | Full `git clone`, copy config.ini + start_option_combo.sh, pip install, launch |
| **Upstream updated** (restart) | Detects remote HEAD differs → `git fetch && git reset --hard`, re-copy config + shell script, pip install, launch |
| **No changes** (restart) | Skips clone/fetch/config/pip, launches immediately |

The entrypoint compares `git rev-parse HEAD` against `git ls-remote origin HEAD`. If they match, it skips all setup steps for a fast restart.

When a clone or fetch is triggered, the entrypoint always:
- Copies `config.ini` over the repo's default
- Checks if `start_option_combo.sh` exists in the repo; if not, copies the bundled version in

## Configuration

### Default `config.ini`

```ini
[tws]
host = 10.3.10.253
port = 7496
client_id = 999

[server]
ws_host = 0.0.0.0
ws_port = 8765

[execution]
managed_reprice_threshold_default = 0.01
managed_reprice_interval_seconds = 2.0
managed_reprice_max_updates = 12
managed_reprice_timeout_seconds = 600
```

### Environment Variable Overrides

Override `[tws]` and `[server]` sections at `docker run` time:

| Env Var | Config Key | Default |
|---|---|---|
| `TWS_HOST` | `tws.host` | `10.3.10.253` |
| `TWS_PORT` | `tws.port` | `7496` |
| `TWS_CLIENT_ID` | `tws.client_id` | `999` |
| `WS_HOST` | `server.ws_host` | `0.0.0.0` |
| `WS_PORT` | `server.ws_port` | `8765` |

Example:

```bash
docker run -e TWS_HOST=192.168.1.100 -e TWS_PORT=7497 -p 8000:8000 -p 8765:8765 option-combo-starter
```

Changing env vars requires creating a new container (not just restarting), which triggers a full fresh setup.

## Ports

- **8000** — Web UI (`index.html`)
- **8765** — WebSocket bridge (IB server)

## Bundled Files

| File | Purpose |
|---|---|
| `config.ini` | Default TWS/server/execution config, copied into the repo at setup |
| `start_option_combo.sh` | Linux-compatible launch script (from unmerged branch), copied into the repo if upstream doesn't have it yet |

## Notes

- The upstream repo only has `start_option_combo_mac.command` (macOS-specific). `start_option_combo.sh` is bundled here from an unmerged branch and will be copied in automatically. Once it's merged upstream, the copy step becomes a no-op.
- Git clone runs at container start (not image build) so the container always gets the latest upstream code.
- `[execution]` section values are baked into `config.ini` and not overridable via env vars (add more if needed).
