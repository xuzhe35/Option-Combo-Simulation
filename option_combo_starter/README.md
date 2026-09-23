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

The repo checkout lives in the container layer. With the supplied Compose
configuration, the `option-combo-state` named volume holds the yield-curve
snapshot at `/app/state/yield_curve` and the cost ledger at
`/app/state/cost_basis/cost_basis.db`. Other databases use their configured
paths; this volume does not automatically relocate the workspace store.

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

### WebSocket access and ledger storage

The backend reads the following settings directly from its inherited
environment; they do not need to be copied into `config.ini` by the starter.

| Environment variable | Fallback config key | Behavior |
|---|---|---|
| `OPTION_COMBO_COST_BASIS_TRUSTED_PEERS` | `cost_basis.trusted_peers` | Comma-separated peer IPs/CIDRs allowed in addition to loopback. Unset uses config; an explicitly empty value clears config back to loopback-only. |
| `OPTION_COMBO_COST_BASIS_ALLOW_REMOTE` | `cost_basis.allow_remote` | `true` admits every peer (Tailscale-protected deployments only); a request passes if this or the trusted-peer list allows it. The environment wins; false, empty, or invalid values keep it closed. |
| `OPTION_COMBO_COST_BASIS_DB_PATH` | `cost_basis.db_path` | Nonblank environment value wins, then config, then the platform application-data directory. The supplied Compose sets a persistent path under `/app/state`. |

Both backends accept arbitrary browser origins, `null`, and missing Origin
headers during the WebSocket handshake. The strict localhost-origin policy
introduced in September 2 commit `01292bc` was rolled back after it caused
HTTP 403 failures in previously working LAN/Nginx Proxy Manager setups.
Existing `OPTION_COMBO_WS_ALLOWED_ORIGINS` and `server.allowed_origins`
settings are ignored and may be removed. The compatibility module returns a
fixed nonempty localhost tuple so an already-baked `20260911` supervisor can
still send its monitor header; that return value does not authorize or
restrict backend access.

Remote ledger access stays disabled unless explicitly configured. Peer
settings use literal IPs or CIDRs, not hostnames; invalid entries deny all
remote ledger access, and wildcards/default routes are rejected. These
settings do not enable remote workspace persistence or database-admin access.
There is no browser-origin gate or per-user authentication: a trusted proxy
represents every client it admits. Network/proxy ingress controls must protect
the shared trading-capable socket. An unrelated website can attempt a
connection through any browser that can reach the backend, even on localhost.

A new cost database and its parent directories are created lazily on the first
allowed ledger request, not merely when the web page or Python process starts.
An unmounted writable path works in the container layer, but will not survive
container replacement. To use a host directory instead, set the DB variable
to `/data/cost_basis.db` and add a bind mount such as
`/srv/option-combo-example/data:/data`, retaining any existing state volume.
Use a writable directory mount, not just a single DB file: SQLite also needs
its WAL/SHM files. Give each independent stack its own ledger storage.

Before changing the path or replacing a container that already has ledger
data, preserve it with a SQLite-consistent backup. A path change does not
migrate the old ledger; an empty directory creates a new empty database. Do
not copy only a live `.db` file while its WAL is active. Workspace recovery
sets do not back up the separate cost ledger.

### Nginx Proxy Manager: LAN deployment

This setup preserves the current HTTP page plus `ws://` connection behavior.
It does not add frontend `wss://` support: enabling Force SSL for the page
alone can cause mixed-content blocking. Keep this HTTP deployment on a
trusted LAN/VPN; do not expose it to the public Internet.

1. Protect **both** the frontend and WebSocket proxy hosts with the intended
   LAN/VPN boundary and/or NPM IP Access Lists. Restrict any published backend
   ports so clients cannot bypass the proxy. Origin is not user authentication
   and no Origin restriction is enforced. The shared live WebSocket supports
   trading operations even though the cost-ledger page itself does not trade. Trusting NPM means
   trusting every client NPM admits, not just the colleague's browser.
2. Prefer a dedicated Docker network shared by NPM and this service, with a
   fixed NPM IP. Point NPM at the unique application service name on that
   network. With this arrangement, host-published application ports are not
   necessary; avoid publishing them when nothing else needs them. This follows
   [NPM's Docker-network guidance](https://nginxproxymanager.com/advanced-config/#best-practice-use-a-docker-network).
3. Configure two NPM Proxy Hosts. For the frontend, forward
   `app.example.test` using scheme `http` to the application container's port
   `8000`. For the WebSocket host, forward `ws.example.test` using scheme
   `http` to the same container's port `8765` and enable **Websockets Support**.
   If NPM instead reaches the Docker host's published ports, use their host-side
   numbers, not `8000`/`8765` blindly: for a mapping `28000:8000`, the frontend
   upstream port is `28000`; for `28765:8765`, the WS upstream port is `28765`.
   `localhost` inside the NPM container refers to NPM itself, not the app.
4. No Origin rewriting or allow-list configuration is needed. NPM's Websockets
   Support must pass the WebSocket Upgrade/Connection headers to the backend; see
   [nginx's WebSocket proxying requirements](https://nginx.org/en/docs/http/websocket.html).
5. Add the backend's actual NPM TCP peer IP to the existing service's
   `environment` block. The following is an additive example, not a replacement
   for the rest of the stack:

   ```yaml
   environment:
     OPTION_COMBO_COST_BASIS_TRUSTED_PEERS: "192.0.2.10"
     OPTION_COMBO_COST_BASIS_DB_PATH: "/app/state/cost_basis/cost_basis.db"
   ```

   All example domains/IPs are placeholders. On a direct shared network the
   peer should be NPM's network IP. When NPM reaches host-published ports,
   Docker networking may make the peer appear as a host/bridge gateway address
   instead. Verify it from the backend's rejected-ledger-request log and
   Portainer's network details; do not guess it from the browser address.
   `X-Forwarded-For` and `X-Real-IP` are not used for this authorization. Prefer
   one fixed exact IP to allowing a whole Docker subnet. Trusting a gateway
   address also trusts any other connections Docker presents through it, so
   blocking direct access is especially important in that arrangement.
6. Redeploy/recreate the container when changing its environment or mounts.
   A plain restart does not apply Compose environment changes; see
   [Docker's restart documentation](https://docs.docker.com/reference/cli/docker/compose/restart/).
   Keep each stack's own TWS settings, port mappings, and storage. For the
   Origin rollback alone, a source update and container restart suffice; see
   the build/deployment notes below.
7. Open `http://app.example.test/cost_basis.html`. In its connection settings,
   use `ws.example.test` as the server and `80` as the port, then save and
   reconnect. Do not enter the upstream container port when the browser is
   reaching NPM on port 80.

Verification is deliberately separate from broker actions: no test trade or
ledger write is needed. Confirm the supervisor no longer repeats its status
monitor HTTP 403 failure, the browser's WS handshake is `101 Switching
Protocols`, and the ledger status becomes available. TWS may still be offline
while the database is usable. With the updated backend, Origin no longer
causes a handshake 403. If 403 persists, check NPM access policy and verify the
running backend actually loaded the updated source. `remote_access_disabled`
after a successful handshake points to the TCP-peer allow-list. A storage initialization failure after
those checks calls for checking the configured directory and permissions.

## Build and run

### Remote ledger through Tailscale

The ledger defaults to local connections only. For a server whose HTTP and
WebSocket ports are accessible only through your authenticated Tailscale network,
enable remote ledger access with these container environment variables:

```yaml
environment:
  OPTION_COMBO_COST_BASIS_ALLOW_REMOTE: "true"
  OPTION_COMBO_COST_BASIS_DB_PATH: "/app/state/cost_basis/cost_basis.db"
```

Keep the existing `option-combo-state:/app/state` volume mount. The updated
Compose file already supplies the database path; add
`OPTION_COMBO_COST_BASIS_ALLOW_REMOTE=true` to the `.env` file next to it, then
run from `option_combo_starter/`:

```sh
docker compose up -d --force-recreate option-combo
```

The updated backend code must first be available on the upstream `main` branch
that this starter clones (see below), or in your custom deployed checkout/image.
These two variables are read directly by the backend on every start, so an
existing starter image can use them once it has fetched the updated backend;
they do not depend on `config_overlay.py` or require a starter image rebuild.
Changing container environment variables requires recreation, not just restart.

No `allowed_origins` setting is needed: both backends currently accept any
browser Origin (see [WebSocket access and ledger storage](#websocket-access-and-ledger-storage)).
That makes the Tailscale restriction on the published ports the only access
boundary for this setup.

Open `http://<server-tailscale-host-or-ip>:8000/cost_basis.html` in the local
browser. Under settings, set the server host to the same Tailscale host/IP and
the WebSocket port to `8765`. The ledger status should become ready and creating
and reading books should work even when TWS is offline (enter the account
manually). Books are stored on the server's persistent volume.

This switch trusts the deployment's network authentication; it does not perform
a separate Tailscale login inside the app. Ensure the published ports are
restricted to that network. Docker may present a bridge address instead of the
original Tailscale address, which is supported without trusting forwarded headers.
Workspace persistence/admin permissions are separate and remain loopback-only.

If this container already has ledger data at the old default location, export a
ledger JSON backup before replacing it, then restore it after switching database
paths. Selecting a new path starts a new database; it does not move existing data.

### Source and image

The image does **not** embed the Option Combo project source. At startup it
clones the hardcoded
[`xuzhe35/Option-Combo-Simulation` `main` branch](https://github.com/xuzhe35/Option-Combo-Simulation).
The implementation must therefore be merged **and published** to that remote
branch before deployment; a local merge alone does not update remote
containers. This includes the backend environment/peer-policy changes above.

The `20260911` tag in the maintained commands is a release target, not a claim
that an image has already been built or published. Run the release build from
this directory (not an older standalone copy of the starter) and publish it
before selecting that tag in Portainer.

The Origin-policy rollback does **not** require another starter image build.
After the application update is published to upstream `main`, restart the
existing container so the starter fetches the changed source and launches the
updated backend. Verify the fetch/update succeeded: a restart that falls back
to an old checkout will retain the old behavior. The already-baked
`20260911` supervisor remains compatible because the updated
`websocket_security.read_allowed_ws_origins` shim returns a fixed nonempty
localhost tuple while ignoring legacy settings. Older monitors that omit
Origin can also connect after the backend update. No additional Python
packages are introduced by this rollback. Changing supported environment
values or mounts still needs container recreation; changing baked starter
scripts or runtime packages requires a new image build.

Run the build examples from `option_combo_starter/`. The date-stamped tag in
these files is an example/release identifier, not evidence of the latest
published registry image; use the tag you actually build or deploy.

`sample_commands.txt` is the direct build/run replacement. `docker-compose.yml`
contains the equivalent service definition and an equivalent `docker run`
comment. `docker-build.txt` contains the release build command for
`linux/amd64`, including the date-stamped registry tag and push.

Published ports remain:

- `8000`: web UI
- `8765`: WebSocket bridge
