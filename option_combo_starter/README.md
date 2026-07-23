# Option Combo Starter (Docker)

Docker wrapper for
[Option-Combo-Simulation](https://github.com/xuzhe35/Option-Combo-Simulation).
It keeps the same container name, ports, TWS/server environment variables, and
image repository used by `sample_commands.txt`, so the new image can replace
the previous starter image without changing its callers.

## Runtime layout

`entrypoint.sh` performs repository setup, then replaces itself with
`supervisor.py` as container PID 1. The supervisor owns container lifecycle,
not IB market-data state:

- `python -m http.server 8000` and `ib_server.py` are critical child processes.
  If either process exits, PID 1 terminates the other and exits non-zero so
  Docker's `unless-stopped` policy can restart the container.
- An ordinary TWS/API disconnect does **not** restart either child or the
  container. `ib_server.py` is the single reconnect owner.
- The Docker supervisor observes IB status over the local WebSocket for
  operational logging only. It never sends a competing connect request.
- Yield-curve maintenance is independent of IB connectivity and runs in a
  separate optional scheduled task. A yield update failure is logged but can
  never stop a critical child or make PID 1 restart the container.

The runtime image contains `config.ini`, `config_overlay.py`, `entrypoint.sh`,
and `supervisor.py`. The build-only `Dockerfile` is intentionally not copied
into the image.

## Startup behavior

| Scenario | Behavior |
|---|---|
| New container | Clone the upstream repo, overlay the starter-owned config keys, and install Python requirements. |
| Upstream changed | Fetch/reset to upstream `main`, reapply the starter-owned config overlay, then reinstall requirements. |
| No upstream change | Keep the existing checkout and start the supervised services immediately. |
| Remote probe/fetch unavailable | Give the network operation a finite deadline, then log a warning and start the valid local checkout instead of entering a container restart loop. |

The repo checkout lives in the container layer. The yield-curve snapshot lives
in the `option-combo-state` named volume at `/app/state/yield_curve`.

Clone, remote-probe, and fetch operations each have a 60-second wall-clock
deadline plus a five-second termination grace. Set
`OPTION_COMBO_GIT_NETWORK_TIMEOUT_SECONDS` to another positive whole number to
change the deadline. A timed-out probe or fetch fails open only when a valid
local checkout already exists; a timed-out first clone exits so Docker can
retry rather than launching an incomplete checkout. First clones are built in
a staging directory and promoted only after success, so a timed-out partial
clone cannot poison the next container restart.

Setup completion is recorded in `/app/.option_combo_setup_head` for the current
Git commit only after the config overlay and dependency installation all
succeed. If setup is interrupted, the absent/stale marker makes the next
container start retry setup instead of repeatedly launching an incomplete
runtime.

## TWS reconnect behavior

After an unexpected TWS/API disconnect, `ib_server.py` attempts to reconnect
immediately and then every 600 seconds while TWS remains unavailable. A manual
frontend connect request wakes the same supervisor; it does not create a second
reconnect loop.

IB error **326** specifically means the API client ID is already in use. Only
after observing that exact error, the supervisor lowers the effective client ID
by one and promptly retries. Repeated 326 responses lower it one step at a time
down to the safe floor of 1. Other connection failures never change the client
ID and retain the normal ten-minute retry cadence. The configured
`TWS_CLIENT_ID` is not rewritten; a new container starts from that configured
value again.

On reconnect, live subscriptions are invalidated and replayed once. Managed
combo repricing is stopped for manual review before any further order change;
the supervisor does not cancel or replace the broker's still-live order.

## Yield-curve scheduling

PID 1 runs one automatic update at **09:30 America/New_York on each weekday**:

```text
python -m yield_curve update --if-needed --data-dir /app/state/yield_curve --json
```

The scheduler persists the attempted New York date in the shared state
directory, so replacing or restarting the container later that day does not
repeat the automatic request. Weekends are skipped. There is no same-day retry
after a failed, partial, timed-out, or cache-fallback attempt; the next
automatic request is the next New York weekday's scheduled attempt.

The updater publishes only a complete new snapshot. If either official source
or the updater process fails, the last successful snapshot remains in the
persistent volume. Yield data is optional: scheduler failure is isolated from
the HTTP server, `ib_server.py`, IB reconnect handling, and container
lifecycle.

For this Docker deployment, the config overlay forces
`yield_curve.auto_update_if_missing = false` and
`yield_curve.auto_update_if_stale = false`. The PID-1 scheduler is therefore
the sole **automatic** yield-curve writer; manual updater commands remain
available for operator maintenance.

The timing can be adjusted with:

| Environment variable | Default |
|---|---:|
| `OPTION_COMBO_YIELD_DAILY_HOUR_NY` | `9` |
| `OPTION_COMBO_YIELD_DAILY_MINUTE_NY` | `30` |
| `OPTION_COMBO_YIELD_PROCESS_TIMEOUT_SECONDS` | `120` |
| `YIELD_CURVE_DATA_DIR` | `/app/state/yield_curve` |

## Configuration

The freshly cloned repository's `config.ini` remains the base configuration.
This preserves team-maintained sections and settings added by upstream. The
starter atomically overlays only the six environment-backed keys below; each
nonempty environment value takes precedence over the corresponding bundled
`config.ini` default. It also disables the two backend yield auto-update flags
described above so there is only one automatic writer. Other keys in the
bundled config are not copied into the repository config.

| Environment variable | Config key | Default |
|---|---|---|
| `TWS_HOST` | `tws.host` | `10.3.10.253` |
| `TWS_PORT` | `tws.port` | `7496` |
| `TWS_CLIENT_ID` | `tws.client_id` | `999` |
| `WS_HOST` | `server.ws_host` | `0.0.0.0` |
| `WS_PORT` | `server.ws_port` | `8765` |
| `YIELD_CURVE_DATA_DIR` | `yield_curve.data_dir` | `/app/state/yield_curve` |

`OPTION_COMBO_IB_STATUS_HOST` optionally overrides only the supervisor's local
status-monitor destination. By default it is derived from `WS_HOST`; wildcard
bind addresses such as `0.0.0.0` and `::` are mapped to loopback for dialing.

Changing these values requires replacing the container, not merely restarting
the same container, because setup overrides are applied when a checkout is
created or updated.

## Build and run

The image does **not** embed the Option Combo project source. At startup it
clones the hardcoded
[`xuzhe35/Option-Combo-Simulation` `main` branch](https://github.com/xuzhe35/Option-Combo-Simulation).
The reconnect implementation commit must therefore be merged into that branch
before a container from this image is deployed; otherwise the new container
will run the older backend from upstream.

`sample_commands.txt` is the direct build/run replacement. `docker-compose.yml`
contains the equivalent service definition and an equivalent `docker run`
comment. `docker-build.txt` contains the release build command for
`linux/amd64`, including the date-stamped registry tag and push.

Published ports remain:

- `8000`: web UI
- `8765`: WebSocket bridge
