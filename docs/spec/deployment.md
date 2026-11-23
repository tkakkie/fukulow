# Spec: Deployment

Index and Terms: [docs/spec.md](../spec.md).
Related: [Setup token](accounts.md#setup).

## Proxy and sign-in limits
- Web/native sign-in share process-local failure budgets of 20 per IPv4 address or IPv6 /64 and 5 per normalized Account email per 60 s. IPv4-mapped IPv6 uses the IPv4 budget. In-flight attempts reserve capacity and successes release it. Password change and revoke-others use their own budgets of 3 per Session and 5 per Account per 60 s instead (#760), so an Account allows 5 + 5 wrong passwords per window. Each budget map holds at most 10,000 keys.
- Standalone forwarding is opt-in. Set both `FUKULOW_TRUSTED_PROXIES` (comma-separated IPv4/IPv6 addresses or CIDRs) and `FUKULOW_CLIENT_IP_HEADER` (HTTP header name). Invalid or partial configuration stops startup. CIDR prefixes use decimal digits with no sign or leading zero except `/0`. Host bits are allowed and ignored for matching. IPv4-mapped IPv6 peers become IPv4, which matches IPv4 ranges or mapped IPv6 ranges wholly within `::ffff:0:0/96` (mapped address, prefix ≥96). Other IPv6 ranges cannot match IPv4 peers.
- Only the trusted immediate socket peer can supply a client IP. It must append or overwrite the rightmost comma-separated IP in one header field. Ignore earlier values even if invalid. A missing, repeated or non-text field or invalid rightmost IP falls back to the socket peer. Ignore the entire header from untrusted peers.
- Run exactly one HTTPS profile, `--profile caddy` (default) or `--profile nginx`. Only proxy/app join `edge`, and only app/migrate/DB join `backend`. App ports are unpublished by default. `FUKULOW_EDGE_PREFIX` (default `172.30.94`) sets subnet `<prefix>.0/29`, gateway `.1`, fixed proxy `.2`, fixed app `.3` and dynamic range `.4/30`, keeping dynamic containers off the fixed IPs. Compose sets `x-forwarded-for` and trusts only `.2`, ignoring `.env` overrides of `FUKULOW_TRUSTED_PROXIES` and `FUKULOW_CLIENT_IP_HEADER`.
- Use proxy health checks. For temporary local HTTP/debug access, pass `-f compose.yml -f /path/to/debug.yml` with `services: {app: {ports: ["127.0.0.1:8080:8080"]}}`. This peer is untrusted and headers cannot select a sign-in budget. Remove the override afterward.
- Before upgrading, set a random `FUKULOW_SETUP_TOKEN`. Missing/empty fails Compose interpolation before recreation, preserving the stack/volume. The token gates setup only, remains required afterward and does not affect existing Accounts or sign-in. Move legacy host probes from `127.0.0.1:8080` to the proxy or use the debug override. For subnet overlap, set `FUKULOW_EDGE_PREFIX` to three octets of a free private IPv4 subnet and recreate. Keep trust limited to the proxy.
- Compose security checks isolate both profiles, use disposable values/ports/volumes, ignore deployment `.env` and clean up their resources. The security/restart harnesses use random private edge prefixes from separate ranges unless `CHECK_EDGE_PREFIX` selects a free subnet. `CHECK_COMPOSE_IMAGE` reuses a local image for security checks. [Deployment and auth invariants](../invariants/deployment.md#rows-in-other-parts)

## Database deployment and upgrade (#194 B)
- PostgreSQL 17 or newer is required. Bundled PostgreSQL 18 is the Compose default. Its owner is `fukulow`. One-shot `migrate` uses the owner URL and runs `fukulow-server migrate`. App waits for successful migration and uses the `fukulow_app` URL. For standalone/dev set `DATABASE_URL` to the app URL for serving and to the owner URL for migration.
- App startup only reads `public._sqlx_migrations`. Missing history, missing/extra/different versions, checksum mismatches or failed rows prevent listening. App never repairs or migrates. One-shot migration lock waits, including SQLx advisory locks, stop after 5 s. Resolve the blocker and retry manually with app stopped.
- App connections set `statement_timeout = 10s` and `jit = off` at connection startup, overriding URL options and role/database defaults without a per-connection query. App binds TCP, verifies both on an app connection, and exits without serving HTTP unless both match. Use HTTP readiness rather than a TCP connect. The owner connection does not get these settings. Migrations disable statement and transaction timeouts.
- `migrate` without `fukulow_app` exits before schema changes and directs the operator to `migrate roles`.
- `fukulow_app` is LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT, NOREPLICATION and NOBYPASSRLS, without ownership or memberships in either direction. It gets CONNECT, public-schema USAGE, table SELECT/INSERT/UPDATE/DELETE and sequence USAGE, subject to SELECT/INSERT only on append-only `channel_log`, SELECT only on migration history, and exclusion of `organizations.history_generation` from INSERT/UPDATE. No CREATE, TEMP, TRUNCATE or trigger changes in the app DB. Other databases keep their PUBLIC privileges. Default DML/sequence grants cover future migration-owner objects. `migrate` reapplies history/log exceptions. RLS restricts the app to the transaction-local Organization or, read-only, the verified Account’s own Members and their Organizations. Owner bypass covers migrations, backup/drill and explicit generation rotation over the owner URL. Runtime cannot choose or update an epoch. Grant `fukulow_app` EXECUTE on `fukulow_setup_required()` and revoke it from PUBLIC, including after no-ACL restore.
- Bundled mode requires nonempty `POSTGRES_PASSWORD` and a distinct URL-safe `POSTGRES_APP_PASSWORD` (e.g. `openssl rand -hex 32`). Role setup requires a superuser. Before sending the password, suppress statement/parameter/error-context logging and nested pg_stat_statements tracking transaction-locally or fail closed. Bind/quote the password as data and let PostgreSQL quote the utility statement. Suppress role-update diagnostics and keep passwords out of SQL files.
- Initdb runs `deploy/init-db-roles.sh` with shared roles/grants SQL on new volumes only. To upgrade, take and drill a backup first, privately set setup token and new app password, build the matching image, and stop app/writers. Run `docker compose run --rm migrate roles`, then `docker compose --profile caddy up -d` (or nginx). Roles updates password/grants idempotently without changing rows. It refuses ownership/membership without reassigning or deleting anything. Reuse the password on subsequent runs. Rotation requires app recreation. Never remove the volume to fix an upgrade.
- The disposable populated-volume [upgrade check](../../scripts/check-db-upgrade.ts) uses `origin/main` in an isolated directory and never loads deployment `.env`. `CHECK_COMPOSE_IMAGE` reuses a built candidate. `CHECK_UPGRADE_CACHE_FROM` lets CI reuse main’s layers via buildx `--cache-from`. CI runs it after building the candidate.
- Restore with `--no-owner --no-acl` so the disposable drill needs no role creation for grants. In production, reapply ACLs/default privileges without changing data after the database-name switch and before starting app. End restored Sessions and reconcile permissions. [Recovery procedure](#production-recovery-maintainer-operated)

### External PostgreSQL (#810)

1. Create a dedicated database owned by the migration login. Reserve the cluster-wide `fukulow_app` login for this deployment. Allow the operator and app/migrate containers to reach the server's TLS hostname.
2. In a private `.pg_service.conf`, configure `fukulow-bootstrap` with the target instance, database, administrator login, `sslmode=verify-full` and trusted CA. Use a 0600 passfile. The administrator needs the role and logging rights above and the ability to assume the migration owner. Providers that restrict those rights must perform bootstrap with those protections.
3. Supply a distinct `POSTGRES_APP_PASSWORD` privately to the script. From the checkout, run the shared role and grant SQL as one transaction. Substitute your migration login for `fukulow`.

   ```sh
   PGSERVICE=fukulow-bootstrap FUKULOW_DB_OWNER=fukulow deploy/init-db-roles.sh --external
   ```

4. Set `FUKULOW_APP_DATABASE_URL` for `fukulow_app` and `FUKULOW_MIGRATE_DATABASE_URL` for the owner. Use the same database, URL-encoded credentials and `sslmode=verify-full`. For a private CA, mount its PEM read-only in app/migrate and add `sslrootcert=/container/path.pem` to each URL. Remove bundled password settings and keep both Compose files in subsequent commands.

   ```sh
   docker compose -f compose.yml -f compose.external-db.yml --profile caddy up -d --build
   ```

   Use `--profile nginx` for nginx. To switch from bundled, stop writers, back up and restore to the new server, then stop the bundled DB with the original configuration. Preserve its volume.

## Deployment (#194 C)
- `FUKULOW_SEARCH_ENGINE` selects `disabled` (Compose default and production setting pending #689) or `d3r` (development/test). To opt in with Compose, add an override setting `services.app.environment.FUKULOW_SEARCH_ENGINE` to `d3r`.

| Compose proxy | Bundled PostgreSQL 18 | External PostgreSQL ≥17 |
|---|---|---|
| Caddy | `disabled`, `d3r` (dev/test) | `disabled`, `d3r` (dev/test) |
| nginx | `disabled`, `d3r` (dev/test) | `disabled`, `d3r` (dev/test) |

- The image runs as UID/GID 10001 with a root-owned executable and no writable application data. Pin base and external deployment/load images by tag plus registry-verified multi-platform SHA-256. Weekly Dependabot updates for the Dockerfile and both Compose directories still need review and deployment checks.
- Deployment/load app and migrate use read-only roots, drop ALL capabilities and forbid new privileges. No writable mounts or tmpfs. DB and proxy state keep their own storage. Fresh and populated upgrades must run under those restrictions. [Deployment invariants](../invariants/deployment.md)
- App and both proxies set `Cross-Origin-Opener-Policy: same-origin` and identical empty `Permissions-Policy` feature allowlists on success and errors, including proxy 404s and upstream failures. Listed features (sensor/media/Clipboard/fullscreen/device and others) are denied. Unlisted features keep browser defaults (no wildcard default). Ordinary editing/paste works. App covers direct access. Proxies replace app copies and cover their own errors via Caddy’s shared normal/error policy and nginx’s http-scope `add_header ... always` without child overrides.
- #401 requires maintainer/orchestrator production-equivalent browser acceptance for each deployed TLS profile. Cover setup, Sign in/out, WebSocket send/reconnect, Channel/Topic/Reply, DM, Mention, Search and any external-window/file flow. HTTP/container checks alone cannot pass the gate. Regressions require a decision before weakening headers.
- If the host interface MTU is below 1500, set the Docker daemon `mtu` and the bridge `default-network-opts` MTU to match it, restart Docker and recreate Compose networks. Otherwise larger container and build traffic can stall.
- All deployment/load services bound Docker-local `json-file` logs to `max-size: 10m`, `max-file: 3` per container. Recreate to apply and arrange separate retention if needed.
- Set `FUKULOW_DOMAIN` (Compose default `localhost`) and keep `FUKULOW_COOKIE_SECURE=true`. The secure-cookie flag defaults to true and standalone accepts only literal `true`/`false`. For production Caddy use a public DNS name pointing to the VPS, reachable TCP 80/443 or the restricted procedure below, persistent `caddy_data` and valid HTTPS before setup/sign-in. Explicitly trust the local certificate only for local checks.
- nginx TLS uses the official image’s bundled official ACME package and full main-context config. Both profiles share domain, edge network and trusted proxy IP. Public TLS requires public DNS and reachable 80/443, subject to the restricted procedure below. nginx defaults to HTTP-01. Challenge paths never redirect. Other configured-domain HTTP redirects to that HTTPS domain. Both reject foreign Host, unknown/missing SNI and Host/SNI mismatches before app access. nginx also validates raw Host for absolute-form targets. Caddy forwards canonical URL authority. HSTS is TLS-only. WSS retains Host and client IP. All API responses, including proxy readiness 404s and upstream errors, are no-store and uncompressed.
- nginx master/workers run as nginx and reuse `nginx_acme` keys across restarts/recreation. State belongs to nginx (0700 dirs, 0600 files). Keep contents out of inspection, exports, logs and artifacts. Binding 80/443 needs Docker’s per-network-namespace `net.ipv4.ip_unprivileged_port_start` ≤80 (normally 0). Otherwise startup fails clearly. nginx lacks DNS-01, so closed 80/443 preclude unattended renewal. TLS-ALPN-01 is optional and outside the tests.
- For public assets, serve embedded sidecars with `Content-Encoding: br` only when Brotli has a positive negotiated q-value. Explicit `br` overrides `*`. Missing/empty `Accept-Encoding` and `br;q=0` use identity. Assets always vary on `Accept-Encoding`. Proxies preserve both representations uncompressed. Apply MIME/cache on the original path (`application/wasm` for wasm). Only Vite manifest outputs are immutable for one year. HTML/SPA fallback/unhashed files use `no-cache`. Sidecar URLs/private Vite metadata return 404.
- Update the nginx tag+digest and exact `NGINX_ACME_PACKAGE_VERSION` in one reviewed PR, manually checking `dpkg-query` on the proposed image. `check-versions.ts` rejects ABI drift and startup verifies the package and loads it with `nginx -t`. Neither module builds nor a custom image are needed. Update Pebble’s tag+digest manually in `scripts/compose-acme.ts` and rerun the checks.
- For the full browser/TLS lifecycle gate use `CHECK_COMPOSE_ACCEPTANCE=1 node scripts/check-compose-security.ts` on main pushes/manual dispatch. PRs run the shorter security check. `CHECK_COMPOSE_PROFILE` narrows a local run and `CHECK_COMPOSE_WORK_DIR` selects temporary fixture storage. Pinned Pebble uses real HTTP-01 with no authorization reuse and ten-minute certificates. A test-only directory omits ARI for lifetime renewal. After restart/recreation, start the reuse observation at directory health and first persisted serial. Require 15 s with unchanged serial, order and account counts. Continue rejecting replacement/new orders before nginx’s earliest renewal window at 48% of certificate validity, truncated to seconds (nginx 0.4.1 varies half-life by 2%). Caddy scans every 5 s at half life. Count only a subsequent new order and serial before original expiry without further restart. Poll every 250 ms and keep checking challenge/redirect/headers.
- **Switching the proxy.** From the checkout run `deploy/switch-proxy.sh nginx` (or `caddy`) with the same Compose options used elsewhere, including any ports override. Requires bash, Docker and host curl.
  1. Record whether the other proxy is running. Create the target without starting it. If its published ports differ from the running proxy’s, exit 2 without changing live bindings. Use `SWITCH_PROXY_ALLOW_PORT_CHANGE=1` only for deliberate changes.
  2. Stop the other proxy, then start the target with `up --wait`. Container port 80 must answer HTTP for `FUKULOW_DOMAIN` (redirect).
  3. Within `SWITCH_PROXY_HTTPS_TIMEOUT` (default 180 s), `https://$FUKULOW_DOMAIN/api/v1/health` through published 443 must return `ok` with matching hostname and trusted chain (host trust store or `SWITCH_PROXY_CACERT`). Failed issuance or trust fails the switch.
  4. On failure stop the target and restart the previous proxy only if previously running, using the same health and HTTPS checks. Exit 1. If restoration fails, check manually.
  - Shared edge IP `<prefix>.2` (and production ports 80/443) prevents simultaneous proxies. Never `up` both profiles. Switching preserves both state volumes (`caddy_data`, `nginx_acme`). Each first start issues a certificate against CA rate limits. Returning reuses cert/account without a new order. `unless-stopped` keeps the other proxy stopped across Docker restarts.
  - Main pushes and manual e2e-compose dispatch check switching against Pebble, including rollbacks and refusal paths. [Switch check](../../scripts/check-compose-switch.ts)
- The binary is PID 1, with Docker’s default SIGTERM and a 75 s stop grace (#195). It starts no children and needs no init wrapper.

### Restricted access through SSH (#392; preparation for #285)

SSH is the first restricted-access candidate, pending maintainer deployment. Allow only SSH on public ingress. Close 80/443 on every public IPv4/IPv6 address, including Docker publications that can bypass host firewall rules. Leave app/DB unpublished. Tunnel unchanged TLS to Caddy for `FUKULOW_DOMAIN=<app-domain>` with a valid domain cert and persistent `caddy_data`. Never tunnel directly to app HTTP.

**Loopback-only proxy ports.** Docker’s base `80:80`/`443:443` binds every host address. Keep a private Compose override outside the checkout for both proxies so switching preserves loopback-only access.

```yaml
services:
  caddy:
    ports: !override
      - "127.0.0.1:443:443"
  nginx:
    ports: !override
      - "127.0.0.1:443:443"
```

Use Compose ≥2.24.4 and `!override`. A plain `ports:` list appends base mappings, leaving public 80/443. Pass both files to every Compose and switch command or recreation can republish those ports. Publish loopback 443 only. Closed ports require an approved nginx renewal window. Run the whole check block on the VPS before and after each change.

```sh
# Before switching: both proxies must render loopback-only ports.
docker compose -f compose.yml -f '<override>' --profile caddy --profile nginx config caddy nginx | grep -A3 'ports:'   # expect host_ip: 127.0.0.1 for both
docker compose -f compose.yml -f '<override>' --profile caddy port caddy 443   # running proxy (or nginx): expect 127.0.0.1:443
ss -ltnH '( sport = :80 or sport = :443 )'                                    # expect only 127.0.0.1:443
```

The maintainer chooses how to issue and renew certificates.

- DNS-01 keeps 80/443 closed. Use a reviewed, pinned custom Caddy build with a DNS provider module (absent from stock), a private least-privilege DNS API token outside the checkout, and outbound DNS/ACME. Account for DNS propagation and token custody.
- HTTP-01 (80) or TLS-ALPN-01 (443) needs correct public DNS and a deliberate short public opening. Isolation weakens during the opening. Renew in another approved window before expiry or switch to DNS-01. One opening cannot renew unattended. An opening has two layers, both temporary:
  - the provider packet filter (and any host firewall) allows the port;
  - Compose publishes it on the public address: prefer a private temporary override whose `ports: !override` lists the loopback 443 plus only the challenge port (for example `"80:80"`), so no other port is published. A plain `ports:` list appends to the base.
  - The filter change can take effect with a delay. Before requesting the certificate, confirm the port is reachable from an external source. A first attempt that fails before the filter applies can be retried in the same window.
  - After issuance, close the filter and restart the proxy with the loopback-only override. Then rerun the check block above and the restriction checks below.

After approval, on the operator machine (replace placeholders privately):

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8443:127.0.0.1:443 '<ssh-user>@<vps-host>'
```

Map `<app-domain>` to `127.0.0.1` locally and browse `https://<app-domain>:8443` (unprivileged port). Keep `<vps-host>` resolving to the VPS. Preserve domain SNI and Host (including `:8443`). Loopback URLs or changing Host alone fail certificate/SNI checks. Keep certificate verification and `FUKULOW_COOKIE_SECURE=true` for Secure/`__Host-fukulow_session` cookies. The browser uses `wss://<app-domain>:8443`. Cookie WebSockets default to an HTTPS same-Host Origin including port. If `FUKULOW_WS_ALLOWED_ORIGINS` is set, require an exact allowlist match and include `https://<app-domain>:8443`. Forwarded headers do not determine Origin. [Auth decisions](../decisions/auth.md)

In one run with tunnel/app healthy, test each public address from an external non-allowlisted source, bypassing local DNS overrides. Both ports must refuse or time out. DNS failure proves nothing and any TCP success fails the check.

```sh
nc -4 -vz -w 5 '<vps-public-ipv4>' 80
nc -4 -vz -w 5 '<vps-public-ipv4>' 443
nc -6 -vz -w 5 '<vps-public-ipv6>' 80
nc -6 -vz -w 5 '<vps-public-ipv6>' 443
```

Test every global IPv6 address from an IPv6-capable source. Skip only if `ip -6 addr show scope global` on the VPS is empty, and record that result.

In the same run on the operator machine require HTTPS 200 (`ok`) and a TLS WebSocket upgrade (`101 Switching Protocols`) through the tunnel.

```sh
curl --noproxy '*' --resolve '<app-domain>:8443:127.0.0.1' --connect-timeout 5 --max-time 10 -sS -D - 'https://<app-domain>:8443/api/v1/health'
curl --noproxy '*' --resolve '<app-domain>:8443:127.0.0.1' --connect-timeout 5 --max-time 10 --http1.1 -sS -D - -o /dev/null \
  --cookie '<private-cookie-jar>' -H 'Origin: https://<app-domain>:8443' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: <base64-16-byte-nonce>' \
  'https://<app-domain>:8443/api/v1/orgs/<organization-id>/ws'
```

Use a valid signed-in Member’s cookie jar (0600, outside checkout) and a base64-encoded 16-byte nonce. Keep credentials out of commands/logs. Require the actual TLS `101` even if curl later times out. Allowed Origin without credentials returns 401 before upgrade. Missing/disallowed cookie Origin returns 403 `origin_not_allowed`.

**Image and operator.** CI publishes no image. `compose.yml` builds it on the VPS (`build: .`) from the checked-out revision. Check out the revision that passed #286, or for the restricted deploy the revision under test, and record it. A VPS build matches that revision’s source, not necessarily the image CI built: do not treat them as identical. The build needs enough memory (swap helps on small plans). Keep deployment `.env` as `root:fukulow-backup` 0640 ([backup runbook](#operator-runbook-and-production-hold-316)). A non-root operator runs Compose with `sudo`, for example `sudo docker compose -f compose.yml -f '<override>' --profile caddy up -d --build`. Do not widen `.env` or add the operator to `fukulow-backup` to avoid `sudo`. Docker access is root-equivalent either way.

**Client IP through SSH.** The VPS/Docker loopback peer (typically the bridge gateway) is shared. One operator can exhaust the shared per-IP sign-in budget (20 per IPv4 address or IPv6 /64 per 60 s). Identify operators by Account, since IP logs/metrics cannot distinguish them. Never add forwarded headers or widen `FUKULOW_TRUSTED_PROXIES` to recover original IPs. Only clients connecting directly to public Caddy regain per-client IPs after lifting the restriction.

[R2 backup, alert and restore gates](#operator-runbook-and-production-hold-316) still apply. Keep credentials, endpoints and account values private. The maintainer owns provisioning, contracts, DNS, certificates, credentials, deployment and lifting the restriction. #285 stays blocked. [Workflow §12](../workflow.md#12-needs-the-maintainer)

## Send limit (#306)
- `FUKULOW_SEND_BURST` (tokens, default 10) and `FUKULOW_SEND_REFILL_PER_SECOND` (tokens/s, default 1) size each (Organization, Member) bucket. Each accepts integers 1..=1,000,000. Standalone uses the default if unset. Empty, zero or invalid values fail startup. [S6](realtime.md#real-time-sync-contract)
- Compose substitutes defaults for unset/empty. Keep production at 10 and 1/s. CI raises limits only for light k6/browser tests using one Member.
- Restart to apply changes. In-process buckets start full. Only size/refill change. Authorization order, idempotency, waiter/key/bucket caps and fail-closed 503 still apply.

## HTTP availability
- `/api/v1/health` is liveness only (plain `ok`, no DB/worker check), subject to shutdown below. Internal `GET /api/v1/ready` returns 200 plain `ok` after DB `SELECT 1` and bounded cleanup succeed, provided the fallback supervisor has not observed an abnormal exit. Unstarted is normal. The latch does not detect a hung worker or an exit the supervisor has yet to observe.
- Readiness failure returns 503 `ErrorBody` `not_ready`, `Retry-After: 1`, without internal details. Health and readiness are no-store. Worker failures need process replacement (#163). DB recovery can restore readiness in-process.
- Overlapping readiness callers share one check and its result. The next caller after completion runs a fresh check. Acquire, query and explicit return each get 200 ms (600 ms total). Errors or query cancellation detaches/drops the socket. Return cancellation/timeout drops its socket and permit. Admission lasts through return/discard, even if the HTTP caller disconnects. Readiness uses at most one FIFO app-pool slot and no send/watermark permits (#156/#158).
- Compose app/load runs `fukulow-server probe` every 10 s (1 s internal / 2 s Compose timeout, 3 failures, 10 s startup allowance). The binary probes readiness on `FUKULOW_ADDR` (default `0.0.0.0:8080`), mapping wildcard IPs to loopback and trying resolved addresses within one deadline. A separate current-thread runtime exits without waiting for stalled blocking DNS. No extra ports or changes to server runtime/shutdown.
- Probes bypass both proxies, which 404 the exact `/api/v1/ready` path and still route `/api/v1/health`. Proxy depends on `service_started`. Unhealthy alone never restarts Compose, which retains #163 abnormal-exit recovery and `restart: unless-stopped`.
- On graceful shutdown outer middleware rejects new API requests, including health and WebSocket handshakes, before auth, extraction or admission. It sends 503 JSON `ErrorBody` `shutting_down`, jittered `Retry-After` of 1–5 seconds and no-store.
- Retry after `Retry-After`, keeping send `client_message_id` (C6). Capacity refusals affect one operation and have the same retry range/no-store: 503 `send admission unavailable` (full queue or 30 s wait expiry, before persistence) and 503 `projection admission unavailable`.

## Logs and aggregates (#198 B)

Read stderr JSON with `docker compose -f compose.yml logs --no-log-prefix --since 10m app`. Docker rotation bounds history. Keep incident extracts private. There is no metrics endpoint, service or persistent metrics store.

- `fields.event=http_completed` carries an `http_request` span through response creation, excluding streaming/WebSocket lifetime. It records `request_id` (fresh UUID per request), method (`OTHER` for extensions), matched route template (`<unmatched>` if unknown), numeric `status` and `duration_ms`. Ignore inbound `X-Request-Id` and add no response header. Never record headers, raw paths/queries or bodies.
- `websocket_opened`, `websocket_closed` and `websocket_disconnected` retain the upgrade span. Fixed `websocket_closed.code` buckets count server attempts, even failed/timed-out writes. Peer Close and transport EOF/error count separately as `peer_or_transport_end`, without peer Close reason/text or arbitrary codes. Disconnect includes cancellation, which may have no Close attempt.
- One `fields.event=metrics` line emits every 60 s, first after 60 s, skipping missed ticks. `active_websockets` counts established callbacks until exit/cancellation and excludes pending/failed handshakes. Close, peer/transport and admission counters are cumulative since start. Atomic reads give approximate snapshots. Restart resets counters and a crash before a tick can lose unreported counts. [Metric fields](../../server/src/observability.rs)
- Admission increments counters at the refusal site without per-rejection diagnostics. Emit at most one `fields.event=admission_rejected` line per nonzero `kind` per tick, with cumulative `count`. Compare deltas for growth. Kinds and Close buckets are fixed and carry no Organization, Channel or Account labels. HTTP completion and socket lifecycle still log individual requests/connections. [Admission kinds](../../server/src/observability.rs)
- `database_failure.kind` is limited to `pool_timeout`, `pool_closed`, `deadline`, `io`, `database`, `other` (SQLx overloading limits classification, #290). Synthetic WouldBlock admission errors only count at admission. Worker stop, cleanup/work deadlines and missing Unread positions have named events without raw errors or entity IDs. Only reviewed `fukulow` events are enabled. `RUST_LOG` cannot enable SQL, parameter or dependency diagnostics. Never log cookies, bearer credentials, passwords, setup/Invite tokens or Message bodies.
- Cleanup DB failures use `span.operation=session_cleanup`. Install the panic hook before tracing/Tokio so startup, task and thread panics emit only fixed stderr JSON `fields.event=panic`, without payload/backtrace. Usual unwind/termination still applies.

### Application pool statistics (#426)

- The serving process emits one JSON line with `fields.event=pool_stats`, `version=1` every 1 s, first after 1 s, skipping missed ticks. `sample_sequence` starts at 1. `sample_elapsed_ms` is actual monotonic elapsed time since previous sample (reporter start for the first). `interval_ms=1000` is the target. Detect gaps before interpreting per-second occupancy. Never fabricate missing samples.
- All app acquisitions after SQLx connects use `database::acquire` or `database::begin` for transactions, including one-statement queries, readiness, detached workers and sign-out revocation, sends, setup status and pre-transaction check, Account Session/Invite/security lookups and startup migration/session validation. The locked setup recheck reuses its transaction connection. Direct SQLx pool acquisition/executors are for owner commands and test fixtures only. `FUKULOW_DB_MAX_CONNECTIONS` defaults to 20 (3..=100). `FUKULOW_DB_ACQUIRE_TIMEOUT_MS` defaults to 5000 (1..=5000 ms). Invalid values stop startup. Neither changes work deadlines.
- `coverage="application_after_connect"`, `uncovered_paths="startup_connect,migration_commands"`. Initial SQLx connection checkout and one-shot owner commands are excluded. Pool maintenance is also unmeasured. Connection failure at serving startup has no sample. These exclusions do not create request-time gaps.
- Wait buckets are inclusive and cumulative in microseconds, with `wait_count` as +∞. Round waits up so values just over 10/50 ms cannot enter those budget buckets. Each success, failure or cancellation counts once at completion. In-flight waits enter a later window. [Wait and occupancy fields](../../server/src/database/stats.rs)
- Outcomes are cumulative success, SQLx `PoolTimedOut`, pool closed, I/O, database, other and cancelled. `waiting` gauges in-flight checkouts. Record the final result, including when SQLx retries a connection error and returns `PoolTimedOut`. Dropped acquires count as cancelled, without distinguishing caller disconnect from deadline. [Pool outcome fields](../../server/src/database/stats.rs)
- `in_use` is SQLx size minus idle (clamp idle to size as reads can race returns/maintenance). `idle` is the idle count. Each line adds one sampled occupancy observation. `occupancy_count` is +∞. Derive p95 from bucket deltas or raw samples, peak from the window’s max `in_use`. No between-sample high-water measurement.
- For a window subtract cumulative endpoint values. The first bucket reaching ceil(q × delta count) bounds percentile q. Exact edges 10,000/50,000 µs and 24/32 allow DM budget checks without interpolation. Require delta `acquire_timeout=0` for no timeout. Review cancellation and other error deltas separately. Expose missing baselines/samples/lines and process replacement to the runner. Process replacement resets counters and concurrent reads make snapshots approximate. No SQL, raw errors, tenant IDs, credentials or request context.

## Operations: backup and restore (#198 C)

### Backup and custody

Use deployment `.env` (0640, group `fukulow-backup`, no other reader), pinned Node, Docker Compose and deployment `COMPOSE_PROJECT_NAME`. Scripts find the root via `import.meta.url`. Run manual commands from checkout root. Backup needs PostgreSQL 18 in `db`. The drill reads the literal pinned `services.db.image` only from tracked `compose.yml`, without running Compose or loading secrets. Update that single definition. Scripts ignore `DATABASE_URL` and suppress diagnostics. Never use `set -x`, print environment/`docker compose config`, save raw errors or put credentials/URLs in cron/arguments/logs. Keep records private.

```sh
umask 077
mkdir -p /srv/fukulow-backups
chmod 700 /srv/fukulow-backups
node scripts/backup.ts /srv/fukulow-backups
```

Use an operator-owned 0700 non-symlink directory below a trusted parent outside checkout/web root. Publish only 0600 `fukulow-*.dump` finals. After dump, flush and `pg_restore --list`, rename and fsync the destination directory. Failed fsync reports failure, preserves new/older archives and requires manual durability/integrity confirmation before copy. Backup/drill failure exits 1 with allowlisted stage/error only. Success prints fixed text without archive path. `--list` checks structure, so also drill. Separately protect roles, server configuration, TLS keys and `.env`. Record code/migration versions. Never migrate the sole restored copy with newer code.

All local writers hold `.backup-run.lock` through dump, encryption, upload, final read-back and cleanup. Under it, sweep only owned 0700 non-symlink directories named `.partial-` or `.partial-age-` plus six alphanumerics. Preserve all other entries and finals. Never copy partials. A stale lock is refused regardless of age/PID. Stop all writers before removing it manually. The next run sweeps remnants. Use trusted parents and the same lock for all writers.

Schedule daily (e.g. 02:15 UTC). Provision space and check free space/success daily. Keep ≥14 successful daily VPS archives, ≥30 off VPS and the latest drilled archive until its replacement passes. Prune VPS finals manually only after verifying off-VPS copies. Never prune the last good copy or prune merely because a job ran.

**External PostgreSQL.** Use provider backups or a custom-format dump. Drill on an isolated target and keep the same custody and capture-age checks. The #316 automation requires the Compose DB.

1. Use `pg_dump` at least as new as the server, an owner libpq service with verified TLS and a private staging file (`umask 077`). Run `PGSERVICE=fukulow-backup pg_dump --format=custom --file="$archive"` and verify with `pg_restore --list "$archive"` before publishing.
2. Recover the provider snapshot to a fresh target or restore as the migration owner with `PGSERVICE=fukulow-restore pg_restore --exit-on-error --single-transaction --no-owner --no-acl "$archive"`. Stop writers before cutover and preserve the original DB.
3. Reapply external role bootstrap and switch both URLs while app is stopped. Follow the [production recovery checks](#production-recovery-maintainer-operated) on the restored target, including Session revocation, permission reconciliation, migration validation and history generation rotation.

### Automated off-VPS backup (#316; mock implementation)

Use a dedicated R2 backup bucket separate from future images, with no lifecycle expiry. VPS token is restricted to backup objects. Keep image credentials out of backups. Checker reads/deletes backups and only lists images for capacity. Maintainer holds a separate read-only restore token. Keep user-owned 0600 token/config files outside checkout, Compose environment and app. Diagnostics/events reveal no private values.

Tracked systemd units match `backupSchedule` in `scripts/backup-r2.ts`: daily 02:15 UTC with persistent catch-up. Hourly Worker cron invokes one named SQLite Durable Object (DO) independently of the VPS. Installation and production activation require approval. After preflight and immediately before PostgreSQL 18 custom dump, timestamp a conservative capture bound. After structural check, encrypt to an age X25519 public recipient and upload ciphertext only. Maintainer keeps the identity offline in at least two places.

Write `backups/<capture-UTC>-<attempt>/archive.dump.age`, then `manifest.json`, then `verified.json`. Strict v1 manifest records capture time, PG major, positive plaintext/ciphertext sizes, their SHA-256 and recipient SHA-256. Marker records manifest SHA-256 and verification time. PUT uses hex SigV4 SHA-256 and base64 checksum. HEAD enables checksum mode and verifies size/checksum. Fully GET-verify archive and manifest before marker, then verify marker too. curl retries all errors (three retries, bounded time). Reconcile uncertain PUT with HEAD. Mismatch abandons the generation and retries a fresh suffix (max three attempts), without overwriting uncertain objects.

Count only a parsed marker matching the strict manifest’s hash, capture matching prefix and at most five minutes ahead, and archive HEAD matching ciphertext size/checksum. Without a valid marker, a known generation is in progress until the newest object upload is six hours old in either namespace. At six hours it alerts as malformed and freezes pruning. Count partial capacity only, excluding freshness, verified totals, selection and pruning. Unknown prefixes are malformed and invalid finals earn no verified credit. Daily VPS check fully reads the newest verified archive. The independent checker uses small JSON and HEAD only. Restore uses the same predicate and verifies the full download against the expected ciphertext hash before decrypting and drilling.

Lock `backups/` for 35 days and `restore-verified/` for 40 days, without lifecycle expiry. Prune at most five generations per check, after every object’s lock, outside the newest 30 verified backups, and never the latest drilled copy or its source capture. An older drilled copy requires a newer one and lock expiry. Freeze all deletions and alert for fewer than 30 verified backups, newest capture ≥24 h old or malformed inventory. After successful monthly drill the maintainer copies all three objects to `restore-verified/<capture-UTC>/`. Latest of the three upload times determines which copy is latest and its drill age. Alert at 35 days without a new one.

Alert on stale/missing backups, malformed or insufficient inventory, failed checks, overdue drills and newest ciphertext <50% or >200% of the previous seven verified archives’ median. Daily alive includes newest capture, backup/image/total bytes, share of decimal 10 GB and account Class A/B usage. Alert at 70%/90% capacity and 70% of 1M Class A/10M Class B ops. Injectable analytics queries the account-wide dataset by UTC day, selecting `dimensions { actionType }` without bucket filter or `groupBy`. Persist validated daily Class A/B totals in the Worker’s current UTC month cache only once six hours have elapsed since that day ended in UTC. Verify this lag margin with the provider before activation. Query today unless empty at midnight and up to three oldest uncached days per run, re-querying recent days until cacheable. All elapsed days need evidence. Cold backfill freezes pruning with `operations-unknown` until complete. Persist closed-day successes even after later errors. Drop the old cache at UTC month rollover. Count actions the provider’s pricing page lists as neither Class B nor free as Class A, accepting overcounting. An empty response for a UTC day closed past the lag counts as zero only when every earlier day of the month is known with zero usage (before the account’s first usage). An empty range for today counts as zero: today is never cached and is requeried, and it is always empty at the first run after UTC midnight, which sends the daily alive. Unnamed actions, other empty and incomplete/capped responses, invalid counts and failed requests yield `operations-unknown`, null usage and frozen pruning. The backup job never refuses a backup to save cost.

Follow opaque S3 ListObjectsV2 tokens through the last page. Each page must match an unfiltered request (absent/empty Prefix, StartAfter and Delimiter, no CommonPrefixes/EncodingType). Scope mismatches even on continuation, missing/repeated/inconsistent tokens, duplicate keys, bad metadata/counts/XML, failed pages or the 10,000-page cap fail the whole inventory. No pruning on partial evidence. `backups/verification-<UUID>/` probes count capacity only and require manual removal after lock expiry.

Both runtimes validate strict v1 checker state with optional `usageCache: {month, days}` (exact UTC dates in month, exact nonnegative safe-integer A/B, no extra cache fields). DO rejects days before the six-hour lag. Corrupt cache is corrupt state, not zero usage. DO state writes are transactional. Node uses an external owned 0600 file with nonblocking/no-follow descriptor checks and fsync/atomic rename/directory fsync. After delivery persist alive UTC day/sent active alerts. Dedup until resolution and retry failures. Missing/corrupt state alerts and freezes pruning that run. Preserve the warning until successful notification, then save valid state only to safe destinations. Retries give at-least-once delivery semantics. A crash between delivery and persistence can duplicate notifications, and delivery is never guaranteed.

VPS uses only the local backup lock. DO sets live busy before first await and takes a transactional run-ID lease. Input gates do not serialize network awaits and long runs exceed `blockConcurrencyWhile`’s safety window. Hold busy through release, refusing live takeover even after expiry. Fence R2/HTTP operations before/after awaits with ownership and a ten-minute action deadline. State writes check run ID transactionally. Twenty-minute lease exceeds the scheduled Worker’s fifteen-minute wall limit. DO fetches have no such bound. After instance death recover at expiry. Stale runs cannot write state, issue deletes or clear successors. Issued deletes may finish after a crash. Delete marker first so remnants freeze the next run. Failed release waits for expiry. Corrupt lease fails closed for inspection. For manual restore-copy/cleanup pause checker and wait for active jobs. Preserve latest drilled source during copy. Daily VPS uploads may overlap checks.

### Worker configuration and free-tier budget (#316)

`workers/backup-checker/wrangler.toml` specifies hourly cron, one named DO, `new_sqlite_classes` and only bucket placeholders. No deployment, login or live probes before approval. After approval substitute buckets and privately set Worker secrets `DISCORD_WEBHOOK_URL`, `ANALYTICS_URL`, `ANALYTICS_TOKEN`, `ANALYTICS_ACCOUNT`. Images permit list only. Backups allow paginated list, HEAD with stored SHA-256, JSON GET ≤16 KiB and guarded deletion. Notifiers share fixed event text. Fetches time out after 30 s. Discord retries transport/429/5xx up to three attempts with `Retry-After` ≤30 s.

Budget Workers Free limits of 50 external fetches, 1,000 internal-service subrequests (R2/DO) and six open connections per invocation. One counter checks before each analytics/Discord fetch. Allow 12 at most, nine normal and three reserved for `checker-failed` only. Expected worst case 4 analytics + 3 summary + 3 failure = 10. Exhausting normal allowance fails the run and invokes the reserved notifier even when analytics would otherwise return unknown. Reserve guarantees attempts within ownership/deadline fences. Receipt depends on provider/network.

Worker sends all newly active alerts and daily alive in one sanitized Discord message (<2,000 characters). Save their state together after delivery. Failures stay retryable. Optional Node runner sends individual notices. Await each operation and consume/cancel each response body sequentially to stay below six open connections.

Count R2 and conservative DO storage calls (transaction entry and each get/put/delete) against 800/run, stopping normal work at 720 and reserving 80 for notification guards, state saves and release. List page/JSON GET/HEAD/DELETE costs one R2 op. Reading a body adds a fenced storage read only. Excess backup pages/generations fail with `checker-failed` and marker-first interruption safety. Check image headroom (four operations) per page. On exhaustion discard partial totals, alert `capacity-unknown`, report null image/total/percentage and freeze all pruning.

Planning example at 38 generations (36 backups and two drill copies), five prunes and one list page per bucket takes 708 counted internal calls before notification, at most 27 more for guards, state and release. Hourly checks give 24 requests/day each to Worker and DO (Free 100,000 each), up to five SQLite writes/run or 120/day (Free 100,000/day) and 19,200 counted reads/day (Free 5M/day). Two bounded keys (state with ≤30 cached days and lease) hold <16 KiB of values plus SQLite overhead (Free 5 GB). In 31 days checker lists/checks use 1,488 A and 141,360 B. Uploads add about 93 A plus verification reads. More inventory, other traffic and retries add usage. Account-wide monitoring is mandatory under the shared 10 GB-month allowance. At 24 ten-minute 128 MiB runs, model 1,800 GB-s/day vs. 13,000 free. Estimates do not prove CPU/wall time. R2 awaits may outlast the deadline with busy held. Confirm provider quotas, CPU/runtime and analytics lag on representative inventory before approval. Quota exhaustion fails closed without paid usage.

### Operator runbook and production hold (#316)

Before activation the maintainer must create production buckets/least-privilege tokens, confirm locks without lifecycle, key custody, Free eligibility/quotas and private Discord delivery, and approve deployment. Use Workers Free, SQLite-backed DO Free and R2 Standard free allowances. No paid configuration. Production login, probes, deployment (including wrangler) and first R2 drill remain on hold. #316 stays open and #285 real-data operation blocked until the VPS completes a full R2 cycle and receives a forced-failure alert, and the maintainer’s machine passes a decrypting R2 drill. Mock tests do not count.

After approval measure a representative encrypted dump before fixing the proposed 5 GB budget. Install the tracked schedules with private configuration outside the checkout. Run daily newest full read-back and monthly download/hash/decrypt/disposable drill, then copy all three objects to `restore-verified/`. Failures emit sanitized events and preserve prior generations. Investigate without printing raw diagnostics. A stale checker freezes pruning. Revoke compromised VPS tokens promptly. Locks protect recent objects, with unlocked objects and forged uploads still at risk. Plausibility checks and decrypting drills provide additional evidence.

An abandoned partial freezes pruning when newest upload reaches six hours, even after a successful retry. Pause backup/copy writers and automatic pruning. Inspect the exact prefix and confirm no upload is still active. Verify a separate complete replacement with the shared predicate and full archive read-back/hash. Preserve ≥30 verified backups, a fresh newest capture and latest drilled copy/source. Record the prefix/reason privately. If still locked, resume scheduled backups with pruning frozen, then repeat all checks after expiry. Once every object is past its 35/40-day prefix lock, remove only that abandoned prefix, marker first if present, then manifest/archive. Never bypass locks or fabricate markers. Re-list and validate, resolve other malformed prefixes, resume writers/checker and confirm freeze alert clears. On any failed check keep pruning frozen and investigate.

Platform/channel outages or missed messages can hide alerts. Use daily alive and weekly manual newest-capture checks during early dogfooding. Inspect growth at 70%. At 90% promptly reduce optimized image variants, consider stronger compression or regenerable data exclusions, then seek paid-usage approval or move provider. Keep image originals for download. Never delete originals, cut retention or refuse backups to save cost. R2 has no spending cap and alerts cannot enforce a billing ceiling. Standard only, with no billable setting enabled.

Credential-free VPS wiring pending activation
- `node scripts/backup-r2-daily.ts <operator-config>` reads owned 0600 external JSON with absolute file paths using `directory` (0700), `recipientFile` (owned 0600 public age recipient), `curlConfigFile`, `baseUrl`, `notifierConfigFile`. On failure attempt `backup-failed` and exit 1 with fixed diagnostics. Success prints fixed text. The local lock covers all work including final newest read-back.
- Notifier JSON is an external owned 0600 regular file with only `webhookUrl`. Discord receives fixed text or reconstructed numeric alive data only. URL stays on curl stdin. Retry network/429/5xx up to three attempts, `Retry-After` ≤30 s. Other 4xx fail immediately. No raw transport diagnostics.
- After approval manually install the units with pinned Node, age, curl and Docker/Compose. Adapt `/opt/fukulow` and `/usr/bin/node`. Use unprivileged `fukulow-backup` with required file/Docker access only, including group read of deployment `.env`. Docker access already grants host-root-equivalent authority. Set `FUKULOW_BACKUP_CONFIG` in operator-owned `/etc/fukulow/backup-path.env` to an absolute config path only. Use persistent external paths outside private tmp. Keep backup credentials out of units, environment files, Compose and the app container.
- `node scripts/restore-from-r2.ts <restore-config>` runs on the maintainer’s machine with pinned Node, age, curl and Docker. Keep restore token/identity off the VPS. Owned 0600 external JSON sets read-only `curlConfigFile`, `baseUrl`, offline `identityFile` and optional exact verified `prefix`. Default to newest verified capture across both namespaces. Store downloaded archive/manifest in 0700 temp. Verify ciphertext hash before decrypting, then plaintext hash/size before disposable drill. Stage verified identity bytes as a 0600 copy to fence check/use races. Never log identity. Remove temp files on success/handled failure. After crash/kill/power loss manually remove `backup-restore-*` leftovers. The command neither switches production DBs nor makes a restore-verified copy.
- `node scripts/backup-r2-verify.ts <verification-config>` is an opt-in gate for approved buckets and external owned 0600 JSON (`curlConfigFile`, `baseUrl`, optional `usageConfigFile` with `curlConfigFile`/`account`). SigV4 curl `user` is `access-id:signing-secret`; negative auth uses same ID and random wrong secret on stdin. Output fixed PASS/FAIL/UNSUPPORTED, exit 1 on FAIL. Write only unique `verification/<UUID>/` and locked `backups/verification-<UUID>/` keys. Verify real SigV4, hex payload and base64 SHA-256 on PUT/HEAD/full GET (including bad-checksum refusal), one-key pagination, lock overwrite/delete denials and optional analytics (whole-month backfill repeated on one in-memory cache while it grows). Clean up unlocked probes and leave the locked probe. Conditional DELETE is informational because checker exclusion uses leases. Inspect actual 35/40-day lock durations and drilled-copy lock separately.

### Mock stage and production gates (#316)

Adapter tests use local fakes. Before production verify provider checksum, pagination, retention, analytics query/schema/permissions (including actionType grouping), DO lifecycle and Free CPU/subrequest budgets in an approved real environment. [Activation gate](#operator-runbook-and-production-hold-316)

Before production, follow the approved-bucket verification procedure above. Require SigV4, checksum and Bucket Lock denial checks, and confirm enforcement during the 35/40-day lock windows.

### Disposable restore drill

```sh
node scripts/restore-drill.ts /private/backups/fukulow-EXAMPLE.dump
```

Use trusted archives (they execute SQL). Size disposable tmpfs or arrange larger disposable capacity. Never mount existing data. Random `fukulow-restore-drill-*` runs without network, ports, mounts, Compose or production URL. After final-server readiness, check archive, restore with `--exit-on-error --single-transaction --no-owner --no-acl` to validate constraints, end all Sessions, then run bundled `pg_amcheck --install-missing --heapallindexed`. Any failure fails the drill. Cleanup removes container and anonymous volumes in `finally`. After interruption inspect/remove only the exact drill container. Never prune globally.

Drill monthly and after schema/image/backup/procedure changes. Privately record size, image/version, counts, time, resources and results.

### Production recovery (maintainer-operated)

Run each recovery command after its predecessor succeeds. Keep stderr private.

1. Retrieve a trusted drilled final, verify off-VPS hash and select matching code. Declare maintenance, stop **all** app instances/writers (`docker compose -f compose.yml stop app`) to disconnect WebSockets, and close ingress separately. HTTP maintenance alone cannot stop writes. Preserve the database and take an incident backup if readable. Never use `compose down -v`, `pg_restore --clean` or overwrite the only database.
2. Use a fresh incident database on production PostgreSQL 18 and replace all example names. If `createdb` finds an existing DB, stop and investigate.

   ```sh
   docker compose -f compose.yml exec -T db createdb -U fukulow -O fukulow fukulow_restore_20261111
   docker compose -f compose.yml exec -T db pg_restore --list < /srv/fukulow-backups/fukulow-EXAMPLE.dump > /dev/null
   docker compose -f compose.yml exec -T db pg_restore -U fukulow -d fukulow_restore_20261111 --exit-on-error --single-transaction --no-owner --no-acl < /srv/fukulow-backups/fukulow-EXAMPLE.dump
   ```

3. **Restore revives ended Sessions and old permissions. End every Account Session and reconcile all post-capture permission changes before reopening.** Keep writers stopped. Auth SQL deletes Sessions across Accounts/Organizations transactionally with bounded waits and an empty-table assertion, without live signals. On failure stay stopped. Verify zero rows and require fresh Sign in. Single-Session API/cookie/expired-Session clearing is insufficient.

   ```sh
   docker compose -f compose.yml exec -T db psql -X -U fukulow -d fukulow_restore_20261111 -v ON_ERROR_STOP=1 < server/src/auth/end-all-sessions.sql
   docker compose -f compose.yml exec -T db psql -X -U fukulow -d fukulow_restore_20261111 -v ON_ERROR_STOP=1 -Atc 'SELECT count(*) FROM public.account_sessions'
   ```

   Session revocation leaves permissions unchanged. Reconcile deactivation/reactivation, Organization Memberships, all Roles, private grants/removals and Membership revisions against incident records. Apply reviewed Organization-scoped corrections without blindly reactivating/copying grants. For unknown changes close affected access pending maintainer resolution.
4. Before the database-name switch, compare the versions and checksums in `public._sqlx_migrations` against the matching release’s migrations and verify all rows have `success=true`. Compare Organization/Account/Member/Channel/Message counts with records. Verify public/private history and attribution, tenant high-water vs. max Message seq, all constraints validated and indexes valid. Run the drill’s `pg_amcheck`, then `ANALYZE`. Resolve failures before switch. Checks cannot recover post-capture writes.
5. Keep app stopped, confirm names and connect through `docker compose -f compose.yml exec -T db psql -X -U fukulow -d postgres -v ON_ERROR_STOP=1`. Block and terminate original connections, then rename. Run each statement successfully outside a transaction.

   ```sql
   ALTER DATABASE fukulow WITH ALLOW_CONNECTIONS false;
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'fukulow' AND pid <> pg_backend_pid();
   ALTER DATABASE fukulow RENAME TO fukulow_before_restore_20261111;
   ALTER DATABASE fukulow_restore_20261111 RENAME TO fukulow;
   ```

   Confirm the new DB is connectable and original closed. On failure inspect names/state and stay stopped without dropping/overwriting. To revert, stop writers, preserve both, rename deliberately, enable only the chosen DB and repeat Session/permission corrections for either copy. Keep the incident copy until maintainer acceptance.
6. After switching names, reapply the app role/password and database grants, including default privileges omitted by `--no-acl`, with matching code (`docker compose -f compose.yml run --rm migrate roles`), using private `POSTGRES_APP_PASSWORD` and no role passwords from SQL. Before starting app or reopening traffic, run matching migrations if required and rotate every restored Organization with `docker compose -f compose.yml run --rm --no-deps --entrypoint fukulow-server migrate rotate-history-generation --all`. Use an Organization UUID instead for a scoped destructive/incompatible replacement. Even if restored counters exceed old cursors, never serve the restored UUID. Startup never rotates. Stay stopped if a step fails. With ingress closed, start matching app (`docker compose -f compose.yml up -d --no-deps app`). Check startup/migrations, liveness, fresh Sign in, old cookie/bearer rejection, Organization isolation and private denial. From a fresh browser check authorized history, send/retry and live delivery. Reopen after maintainer accepts permissions/checks, then take and drill a new backup.
7. Rehearse C8 in isolation with writes paused. Hold a cursor N newer than the backup. Restore and reconnect below N, then verify `subscribed.caught_up_seq=K` below the sent `after_seq=N`, window/cursor discard, unsubscribe, latest bootstrap and live delivery without stale collisions. Unknown sends keep `client_message_id`. Clamp never auto-resends. Use fresh Sign in/history in production and never admit revived Sessions. Also rehearse rotation when restored counters exceed the old cursor. Old-generation subscribe returns `history_generation_changed`, all held Channels reset, pending-send keys survive and bootstrap uses the explicit event watermark even with no visible Messages. Run the server/web recovery suites and Compose generation E2E. [Server](../invariants/realtime.md) · [Client and shared fixtures](../invariants/sync.md)

### Recovery window

RPO target 24 h (#296) is measured from capture of the newest verified off-VPS snapshot. Job start, copy and verification timestamps do not count. There is no RPO guarantee or RTO target. Assess loss from the newest verified accessible off-VPS snapshot. Later writes may be lost. Daily gaps include interval plus dump/copy lag and grow on failures or loss of VPS-only copies. Daily backup/copy/hash and alerts on failure or capture age ≥24 h remain mock only under #316. WAL archiving/PITR wait until after first dogfooding (#285). Measure representative recovery hardware before estimating downtime.

Initial drill conditions, result and timing limits: [measurements: backup restore drill](../measurements.md#backup-restore-drill-198-c).
