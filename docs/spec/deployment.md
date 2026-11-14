# Spec: Deployment

Index and Terms: [docs/spec.md](../spec.md).
Related: [Setup token](accounts.md#setup).

## Proxy and sign-in limits
- Sign-in failure budgets are process-local: 20 per IPv4 or IPv6 /64 and 5 per normalized Account email in a 60-second window. IPv4-mapped IPv6 shares the IPv4 budget. Web and native sign-in share budgets; in-flight attempts reserve capacity, and successful attempts release it.
- Standalone proxy configuration requires both `FUKULOW_TRUSTED_PROXIES` (comma-separated exact IPs or CIDRs, IPv4/IPv6) and `FUKULOW_CLIENT_IP_HEADER`. Invalid/partial configuration fails startup. CIDR prefix lengths use decimal digits without a sign or leading zeros (except `/0`). CIDRs may contain host bits; membership uses the prefix. IPv4-mapped IPv6 peers are canonicalized to IPv4. IPv4 peers match IPv4 ranges or IPv4-mapped IPv6 ranges wholly inside `::ffff:0:0/96` (mapped address and prefix >= 96); other IPv6 ranges never trust IPv4 peers.
- Only a trusted socket peer can supply the client IP. One header field uses its rightmost comma-separated IP, which the immediate proxy must append or overwrite. Missing headers, repeated header fields, a non-text value or an invalid rightmost IP fall back to the socket peer. Earlier comma-separated values are ignored, even if invalid. An untrusted peer's entire header is ignored.
- Compose runs exactly one of `--profile caddy` (HTTPS) or `--profile nginx` (HTTP). Only proxy + app join `edge`; only app, the one-shot `migrate` service and DB join `backend`. The app has no published port by default. `FUKULOW_EDGE_PREFIX` (default `172.30.94`) derives the edge subnet `<prefix>.0/29`, gateway `<prefix>.1`, fixed proxy IP `<prefix>.2`, app IP `<prefix>.3` and dynamic allocation range `<prefix>.4/30`; change this one value to move them together. Dynamic containers cannot take the proxy or app IP. Compose trusts exactly `<prefix>.2`, never the gateway or subnet, and sets `x-forwarded-for` itself.
- For opt-in local debugging, add a temporary Compose override with `services: {app: {ports: ["127.0.0.1:8080:8080"]}}` and pass it with `-f compose.yml -f /path/to/debug.yml`. The published-port peer is untrusted; forwarded headers cannot select a budget. Remove the override afterward. Health checks normally use the selected proxy.
- Upgrade existing deployments: set a random `FUKULOW_SETUP_TOKEN` before `docker compose up`; missing/empty fails interpolation before container recreation and leaves the running stack and volume intact. Existing Accounts and sign-in are unaffected; the token only gates setup, but remains required after setup. The default `127.0.0.1:8080` publication is gone; move host health probes to the proxy or use the debug override above. Existing `.env` values for `FUKULOW_TRUSTED_PROXIES` and `FUKULOW_CLIENT_IP_HEADER` are ignored by Compose. If Docker reports a subnet overlap, set `FUKULOW_EDGE_PREFIX` to three octets of a free private IPv4 subnet (for example `172.29.193` for `172.29.193.0/29`) and recreate the stack; never widen trusted proxies to resolve it.
- `node --test scripts/compose-security.test.ts` checks both configurations; `node scripts/check-compose-security.ts` builds an isolated stack for each profile, testing token setup, sign-in, spoofing over proxy, untrusted backend and published debug-port paths, restart and retained setup. It ignores deployment `.env`, uses disposable values/ports/volumes, and cleans up its own resources. Both it and `check-compose-restart.ts` choose random per-run private edge prefixes in separate ranges; `CHECK_EDGE_PREFIX` can select a known free test subnet. `CHECK_COMPOSE_IMAGE` can reuse a locally built image for the security check.

## Database deployment and upgrade (#194 B)
- Keep `fukulow` as the migration owner. The one-shot Compose `migrate` service uses the same image with `fukulow-server migrate`; only it and DB receive owner credentials. App depends on `service_completed_successfully` and receives only the `fukulow_app` URL. Standalone/dev must run the matching migration command separately with an owner URL; migration commands do not serve HTTP or require setup/proxy settings.
- App startup only reads `public._sqlx_migrations`. Missing history, missing/extra/different versions, checksum differences or any failed row stop startup before listening; it never repairs or migrates. Migration lock waits remain bounded to 5 seconds, including SQLx's advisory lock; failure requires an operator retry of the one-shot service.
- Before applying migrations, the migration command requires `fukulow_app` to exist; otherwise it exits with instructions to run `migrate roles`, leaving the schema untouched.
- `fukulow_app` is LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOINHERIT, NOREPLICATION, NOBYPASSRLS, with no ownership or role memberships in either direction (no role may be a member of `fukulow_app` either). It gets CONNECT, public-schema USAGE, table SELECT/INSERT/UPDATE/DELETE, sequence USAGE and only SELECT on migration history. In the application database it has no CREATE, TEMP, TRUNCATE or trigger-change rights; other databases retain their own PUBLIC privileges. Default privileges apply the same DML/sequence grants to future objects created by the migration owner; the migration command reapplies the history exception afterward. Row-Level Security (#314) restricts it to the transaction-local Organization (or, read-only, the verified Account's own Members); the owner bypasses RLS, so migrations, backups and restore drills run unrestricted. The grants step also limits EXECUTE on `fukulow_setup_required()` to `fukulow_app`, including after a `--no-acl` restore.
- `POSTGRES_APP_PASSWORD` is required by Compose; unset/empty fails closed, never selecting the owner URL. Use a separate URL-safe random value (for example `openssl rand -hex 32`). The role step requires a superuser, as does initdb's Compose owner: before sending the password it transaction-locally suppresses statement/parameter/error-context logging and nested pg_stat_statements tracking, failing closed if settings cannot be changed. It binds/quotes the value as data; PostgreSQL literal-quotes the password utility statement, and role-update diagnostics are suppressed. No password lives in SQL files.
- New volumes run `deploy/init-db-roles.sh` and the shared roles/grants SQL via initdb. Existing volumes do not rerun initdb. Upgrade: take and drill a #198 backup first; set the required setup token (PR A) and new app password in the private deployment environment; build the matching image; stop app/writers; run `docker compose run --rm migrate roles`, then `docker compose --profile caddy up -d` (or nginx). The roles step is idempotent, preserves rows, updates an existing role's password/grants, and rejects ownership/membership instead of reassigning or deleting anything. Keep the same app password on subsequent runs; rotation also requires app recreation. Never remove the volume to resolve an upgrade failure.
- `node scripts/check-db-upgrade.ts` builds the current origin/main image in an isolated temporary directory, populates a disposable volume with Owner, Message and Session, then upgrades it and compares Organizations/Accounts/Members/Messages/Sessions exactly. It tests old-Session access, sign-in, history, restart, privilege denials, #198 backup/drill and restored grants. It never loads deployment `.env`; `CHECK_COMPOSE_IMAGE` may reuse a locally built candidate image; `CHECK_UPGRADE_CACHE_FROM` (buildx `--cache-from`) lets CI reuse main's image layers. CI runs it after the candidate build.
- #198 restores use `--no-owner --no-acl`, so role GRANTs do not require role creation in the isolated drill. For recovery, run the roles step against the restored database after the deliberate database-name switch, before starting app; this restores ACLs/default privileges without changing data. Follow [Operations: backup and restore](#operations-backup-and-restore-198-c), including ending restored Sessions and reconciling permissions.

## Deployment (#194 C)
- The runtime image runs as UID/GID 10001, with a root-owned executable and no writable application data. Dockerfile base images and external deployment/load Compose images use a tag plus a registry-verified multi-platform sha256 digest. Dependabot checks Dockerfile and both Compose directories weekly; image updates still require review and deployment checks.
- Every deployment and load service uses `json-file` logging with `max-size: 10m` and `max-file: 3`. These bounds apply to Docker's local logs per container; arrange separate retention if longer incident history is needed. Recreate existing containers to apply log options.
- Caddy is the default production profile: use a public DNS name pointing at the VPS, reachable TCP ports 80/443, persistent `caddy_data` and valid HTTPS before setup or Sign in. The localhost certificate is for local checks; clients must trust it explicitly.
- The shipped nginx profile serves HTTP only and is **not production-safe alone**. Production requires an external TLS terminator with a valid certificate for the public domain, HTTP-to-HTTPS redirection, HSTS on HTTPS responses (including errors), and WebSocket upgrade support. Restrict nginx's HTTP ingress to that terminator using a firewall or a private/loopback port override; clients must never bypass TLS. Preserve the public Host and keep `FUKULOW_COOKIE_SECURE=true`. The stock nginx config derives HSTS from actual local TLS, so it cannot set HSTS for external TLS; the terminator must do so. Caddy handles the public HTTPS path directly.
- An HTTP TLS terminator also becomes nginx's immediate client. To preserve per-client sign-in budgets, configure nginx real-IP handling to trust only that terminator's fixed IP and a client-IP header it overwrites; verify distinct client budgets. Never trust arbitrary forwarded headers. This deployment-specific configuration is outside the stock HTTP-only profile.
- The binary remains PID 1 with Docker's default SIGTERM stop signal and the existing 75-second stop grace period; #195 handles shutdown. No init wrapper is needed because the server starts no child processes.

## Send limit (#306)
- `FUKULOW_SEND_BURST` (tokens, default 10) and `FUKULOW_SEND_REFILL_PER_SECOND` (tokens per second, default 1) size the per-(Organization, Member) send bucket (S6 in `docs/spec/realtime.md`). Each must be an integer from 1 to 1,000,000; unset uses the default; empty, zero or invalid values fail startup.
- Compose passes `${FUKULOW_SEND_BURST:-10}` and `${FUKULOW_SEND_REFILL_PER_SECOND:-1}`, so production keeps 10 and 1/s unless `.env` sets them. Do not raise them in production; CI raises them only for the light k6 run and browser tests, which send from one Member.
- The settings change only bucket size and refill: authorization order, idempotency, the waiter/key/bucket caps and 503 fail-closed behaviour stay the same. Restart the app to apply a change; buckets are in-process and start full.

## HTTP availability
- `/api/v1/health` remains liveness: plain-text `ok`, no DB/worker check. Internal `GET /api/v1/ready` returns plain-text `ok` (200) when DB `SELECT 1` succeeds, bounded connection cleanup completes and the fallback supervisor has not observed an abnormal exit; not-yet-started is normal. Worker availability is a supervisor latch, not a progress watchdog: a hung worker or an exit the supervisor has not yet observed can still appear available.
- Readiness failure returns 503 `ErrorBody` (`error: "not_ready"`), `Retry-After: 1`, no internal details. Both endpoints use `Cache-Control: no-store`. Worker failure recovers through #163 process replacement; DB recovery can restore readiness in-process.
- Readiness coalesces overlapping callers onto one check and shares its result; the next caller after completion starts a fresh check. Acquire, query and explicit connection return each time out after 200 ms (600 ms total). Errors or query cancellation detach/drop the socket; cancellation or timeout during return drops the return future's socket and pool permit. Admission lasts through return/discard, including when an HTTP caller disconnects. It shares the FIFO app pool, holds at most one slot, and takes no #156/#158 send/watermark permits.
- Compose app/load checks run `fukulow-server probe` every 10 s (1 s internal deadline, 2 s Compose timeout, 3 failures, 10 s startup allowance). The runtime binary probes `/ready` directly on the configured app address/port, trying resolved addresses within one overall deadline and mapping wildcard IPs to loopback; no ports are added. Its separate current-thread runtime shuts down without waiting for stalled blocking hostname resolution; the server runtime and shutdown are unchanged.
- Both proxies respond 404 for the exact `/api/v1/ready` path; `/api/v1/health` routing is unchanged. Compose probes go directly to the app and bypass the proxies. Proxy `depends_on: app` remains `service_started`. Unhealthy alone does not restart Compose; #163 abnormal-exit recovery and `restart: unless-stopped` are unchanged.
- During graceful shutdown, new HTTP API requests return 503 with JSON `ErrorBody` (`error: "shutting_down"`), a jittered `Retry-After` of 1–5 seconds and `Cache-Control: no-store`. This instance is stopping; the outer middleware rejects requests before authentication, extraction or operation admission, including health checks and WebSocket handshakes.
- Clients retry after `Retry-After`, preserving the same `client_message_id` for sends to retain idempotency (C6). Send-admission 503 (`send admission unavailable`) instead rejects one operation because its queue is full or its 30-second admission wait expired; persistence has not started. Projection-admission 503 (`projection admission unavailable`) is also an operation capacity rejection. Both admission responses use the same retry range and no-store policy.

## Logs and aggregates (#198 B)

Read application JSON lines from stderr with `docker compose -f compose.yml logs --no-log-prefix --since 10m app`. Existing Docker rotation bounds retained history; keep incident extracts private. No metrics endpoint, monitoring service or persistent metric storage is added.

- `fields.event=http_completed` carries an `http_request` span with `request_id` (fresh UUID per request), `method`, matched `route` template, numeric `status` and `duration_ms` through response creation (not body streaming or WebSocket lifetime). Unknown routes use `<unmatched>` and extension methods use `OTHER`. Inbound `X-Request-Id` is ignored and no response header is added. Headers, raw paths/queries and bodies are never recorded.
- WebSocket `websocket_opened`, `websocket_closed` and `websocket_disconnected` events retain the upgrade request span. `websocket_closed.code` is a fixed bucket. Counts represent server Close attempts, including failed/timed-out writes, not confirmed receipt. A peer Close or transport EOF/error is counted separately as `peer_or_transport_end`; peer reason/text and arbitrary peer codes are never logged. Disconnect includes task cancellation; an aborted task may have no Close attempt.
- One `fields.event=metrics` line every 60 s (first after 60 s; missed ticks skipped) reports `active_websockets`, `close_1001`, `close_1011`, `close_4001`, `close_4003`, `close_4008`, `close_4029`, `close_other`, `peer_or_transport_end` and `admission_rejections`. Active counts established callbacks, excluding pending/failed handshakes, until callback exit/cancellation. Other counters are cumulative since process start. Each atomic read is safe; concurrent updates mean the whole line is an approximate snapshot. Restart resets all counters; a process dying before a tick can lose unreported counts.
- Admission sites increment counters without per-rejection diagnostics. Each nonzero category emits at most one `fields.event=admission_rejected` line per tick with `kind` and cumulative `count`. Categories: `send_channel_queue`, `send_global_queue`, `send_channel`, `send_global`, `watermark_channel`, `watermark_global`, `notification_channel`, `notification_global`, `notification_organization`, `notification_execution`, `socket`, `password`. Compare successive counts to see growth. Categories and Close buckets are fixed; no Organization, Channel or Account labels. Ordinary HTTP completion and socket lifecycle logs still track individual requests/connections.
- `database_failure.kind` is allowlisted: `pool_timeout`, `pool_closed`, `deadline`, `io`, `database`, `other`. Synthetic WouldBlock admission errors are counted at their admission site, not logged again. Existing SQLx error overloading (#290) still limits classification. Worker stop, cleanup/work deadlines and missing Unread positions have named events without raw errors or entity IDs. Only reviewed `fukulow` tracing events are enabled; `RUST_LOG` cannot enable SQL/parameter/dependency diagnostics. Never log cookies, bearer credentials, passwords, setup/Invite tokens or Message bodies.
- Cleanup database failures include `span.operation=session_cleanup`. A payload-safe panic hook is installed before tracing setup and Tokio runtime construction; startup, task and thread panics emit only the fixed JSON `fields.event=panic` to stderr, without payloads or backtraces. Panics retain Rust/Tokio's normal unwind/termination behavior.

## Operations: backup and restore (#198 C)

### Backup and custody

Use deployment `.env` (0600), pinned Node, Docker Compose and deployment `COMPOSE_PROJECT_NAME`. Scripts resolve root via `import.meta.url`; manual commands require checkout root. Backup requires PostgreSQL 18 in `db`. The drill reads the literal pinned `services.db.image` directly from tracked `compose.yml` without invoking Compose or loading secrets; update that single definition. Scripts ignore `DATABASE_URL`/suppress diagnostics. Never use `set -x`, print environment/`docker compose config`, save raw errors or put credentials/URLs in cron/arguments/logs. Keep records private.

```sh
umask 077
mkdir -p /srv/fukulow-backups
chmod 700 /srv/fukulow-backups
node scripts/backup.ts /srv/fukulow-backups
```

Use an operator-owned 0700 non-symlink directory under a trusted parent outside checkout/web root. Archives are 0600; only `fukulow-*.dump` is final after flush, dump and `pg_restore --list`. Failures preserve older archives. Never copy `.partial-*`; remove leftovers only when no backup runs. `--list` checks structure: also drill. Separately protect roles, server configuration, TLS keys and `.env`; record code revision/migration versions. Never migrate the only restored copy with newer code.

Schedule daily (e.g. 02:15 UTC), provision capacity, check success/free space daily. Keep ≥14 successful daily archives on VPS, ≥30 off VPS, and latest drilled archive until replacement passes. Pruning is manual: only finals with verified off-VPS copies, never last good copy or merely because a job ran.

Copy off VPS: operator-controlled host, 0700 directory, encrypted storage, existing SSH keys, recovery-operator access; same retention on workstations. Archives contain Messages, password/Session hashes and permissions; `pg_dump` has no encryption, SSH protects transport only. Substitute filenames/host:

```sh
sha256sum /srv/fukulow-backups/fukulow-EXAMPLE.dump
scp -p /srv/fukulow-backups/fukulow-EXAMPLE.dump backup@backup-host:/private/backups/.partial-EXAMPLE
ssh backup@backup-host 'chmod 600 /private/backups/.partial-EXAMPLE && sha256sum /private/backups/.partial-EXAMPLE'
```

Compare hashes; rename remotely on the same filesystem to `fukulow-EXAMPLE.dump`, record success, drill that copy. Interrupted copies are never final; SCP alone is insufficient.

### Disposable restore drill

```sh
node scripts/restore-drill.ts /private/backups/fukulow-EXAMPLE.dump
```

Trust archives (they execute SQL); ensure tmpfs fits, or arrange larger disposable capacity, never existing-data mounts. Random `fukulow-restore-drill-*` has no network/ports/mounts/Compose/production URL. After final-server readiness: archive check, restore with `--exit-on-error --single-transaction --no-owner --no-acl` (validating constraints), end all Sessions, bundled `pg_amcheck --install-missing --heapallindexed`. Failures fail the drill; `finally` removes container/anonymous volumes. Interrupted cleanup: inspect/remove only that exact container; never prune globally.

Drill monthly/after schema/image/backup/procedure changes; record size, image/version, counts, time, resources/results privately.

### Production recovery (maintainer-operated)

Run each command only after its predecessor succeeds; keep stderr private.

1. Retrieve trusted drilled final, verify off-VPS hash, select matching code. Declare maintenance; stop **all** app instances/writers (`docker compose -f compose.yml stop app`), disconnecting WebSockets; HTTP maintenance cannot stop writes. Close ingress. Preserve database; incident backup if readable. **Never use `compose down -v`, `pg_restore --clean`, or overwrite the only database.**
2. On production PostgreSQL 18, use a fresh incident database; replace all example names. `createdb` already exists: stop/investigate.

   ```sh
   docker compose -f compose.yml exec -T db createdb -U fukulow -O fukulow fukulow_restore_20261111
   docker compose -f compose.yml exec -T db pg_restore --list < /srv/fukulow-backups/fukulow-EXAMPLE.dump > /dev/null
   docker compose -f compose.yml exec -T db pg_restore -U fukulow -d fukulow_restore_20261111 --exit-on-error --single-transaction --no-owner --no-acl < /srv/fukulow-backups/fukulow-EXAMPLE.dump
   ```

3. **Restore revives ended Sessions/old permissions: end every Account Session and reconcile all post-snapshot permission changes before reopening.** Keep all writers stopped: auth SQL globally deletes Sessions across Accounts/Organizations, transactionally with bounded waits/empty-table assertion, without live signals. Failure: stay stopped; verify zero rows. Require Sign in; single-Session API, cookies/expired-Session clearing are insufficient.

   ```sh
   docker compose -f compose.yml exec -T db psql -X -U fukulow -d fukulow_restore_20261111 -v ON_ERROR_STOP=1 < server/src/auth/end-all-sessions.sql
   docker compose -f compose.yml exec -T db psql -X -U fukulow -d fukulow_restore_20261111 -v ON_ERROR_STOP=1 -Atc 'SELECT count(*) FROM public.account_sessions'
   ```

   Session revocation does **not** fix permissions. Reconcile incident records: deactivation/reactivation, Organization Memberships, owner/admin/member/guest Roles, private grants/removals, Membership revisions. Apply reviewed Organization-scoped corrections; never blindly reactivate/copy grants. Unknown changes: close affected access pending maintainer resolution.
4. Check migration versions/checksums against code (`public._sqlx_migrations`, all `success=true`); Organization/Account/Member/Channel/Message counts against records; public/private history/attribution; tenant-scoped high-water vs max Message seq; no unvalidated constraints/invalid indexes. Run drill's `pg_amcheck`, then `ANALYZE`; resolve failures before switch. Checks cannot recover post-snapshot writes.
5. App stopped: confirm names; connect `psql -X -U fukulow -d postgres -v ON_ERROR_STOP=1` through `docker compose -f compose.yml exec -T db`. Run each statement successfully outside a transaction (renames require it); block/terminate original connections:

   ```sql
   ALTER DATABASE fukulow WITH ALLOW_CONNECTIONS false;
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'fukulow' AND pid <> pg_backend_pid();
   ALTER DATABASE fukulow RENAME TO fukulow_before_restore_20261111;
   ALTER DATABASE fukulow_restore_20261111 RENAME TO fukulow;
   ```

   New database connectable, original closed. Failure: inspect names/state, stay stopped, never auto-drop/overwrite. Revert: stop writers, preserve both, rename deliberately, enable chosen database only, repeat Session/permission corrections (either copy revives authority). Keep incident copy until maintainer acceptance.
6. After the database-name switch, reapply the app role/password and database grants with matching code (`docker compose -f compose.yml run --rm migrate roles`); `--no-acl` deliberately omitted them. The private environment must supply `POSTGRES_APP_PASSWORD`; never restore role passwords from SQL. Failure: stay stopped. Restart matching code (`docker compose -f compose.yml up -d --no-deps app`), ingress closed. Check startup/migrations, liveness, fresh Sign in, old cookie/bearer rejection, Organization isolation/private denial; fresh browser: authorized history, send/retry/live delivery. Maintainer accepts permissions/checks before reopening; take/drill new backup.
7. Rehearse C8 in isolation, writes paused: hold cursor N newer than backup, restore/reconnect below N; verify `subscribed.caught_up_seq=K <` **sent** `after_seq=N`, discard window/cursor, unsubscribe, bootstrap latest history, receive live Messages without stale collisions. Unknown sends retain `client_message_id`; clamp never auto-resends. Production requires fresh Sign in/history; never admit revived Sessions for rehearsal. Run recovery-code server/web suites, including `malformed_controls_and_future_cursor_do_not_break_subscription_state` and fixture `clamp-recovery-with-cached-messages-then-live-delivery`. **C8 cannot detect restored history already beyond the old cursor; clamp alone is not recovery.**

### Recovery window

RPO target: 24 h, not a guarantee (#296), measured from the data capture (snapshot) time of the newest verified off-VPS backup, never from when its copy or verification finished; no RTO target. Daily backup, off-VPS copy, hash verification and alerts (failure, or that capture time 24 h old or older) are automated by #316; until then they are manual. WAL archiving and PITR are deferred beyond the first dogfooding deploy (#285). Daily gap: interval + dump/copy lag, longer with failures/lost VPS-only copies. Assess loss from newest verified accessible off-VPS snapshot, never job start; later writes may be lost. Measure representative recovery hardware before estimating downtime.

Initial drill conditions, result and timing limits: [measurements: backup restore drill](../measurements.md#backup-restore-drill-198-c).
