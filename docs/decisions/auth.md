# Decisions: auth

[Contract](../spec/accounts.md) · [Index](../decisions.md) · [Channels](messages.md#channels-and-messages) · [Delivery](realtime.md#real-time-delivery) · [Web](web.md#web-client)

## Auth, Accounts and tenancy

- #146 global Accounts/Sessions share sign-in across independent Organization Roles. Uniform 404 hides Membership. Global exceptions cover setup existence, credential/Session lookup and cleanup, and own active Organizations. Auth owns Member SQL. Migration reports duplicate normalized emails and aborts without merging or comparing hashes.
- #300 sign-out 401 expires current and legacy cookies for explicit Invite recovery without anonymous fallback.
- #299 shared raw-text validation rejects NUL before DB/hash or sign-in throttle because PostgreSQL cannot store it.
- #197 uses explicit cookie/bearer endpoints to keep web tokens out of JSON. No flag/User-Agent routing. Same-origin XSS can still act as the user or call native sign-in with captured credentials. Migration revoked old bearers because cookie expiry was insufficient.
- #197 FUKULOW_COOKIE_SECURE describes the public HTTPS path, including behind proxies. It selects cookie/CSP wss/Origin policy. False is for local HTTP. Cookie WS requires one same-Host Origin including port or exact FUKULOW_WS_ALLOWED_ORIGINS match. Bearer needs no Origin. Forwarded headers cannot select policy.
- #197 app-wide CSP allows external same-origin scripts/styles and ws(s) to validated Host including port. Forwarded headers cannot widen CSP. Frame denial, nosniff and strict-origin-when-cross-origin cover errors too.
- #197 HSTS max-age=31536000 lives at TLS termination (#469). No subdomains/preload or HTTP challenge/redirect headers. Caddy skips localhost/loopback to protect other dev ports.
- #401: app and both proxies send COOP and Permissions-Policy to cover direct access/proxy errors. Browser acceptance gates deployment and regressions require a decision. [Contract](../spec/deployment.md#deployment-194-c)
- #197 Vite manifest outputs alone get immutable caching. #486 build-time Brotli negotiation replaces proxy compression to cut bytes. [Contract](../spec/deployment.md#deployment-194-c)
- #196 bounds shared Argon2 workers and waiting (including setup/Invite hashing) for memory and bursts. Reserve IP/email then admit before lookup: one permit covers lookup/hash, hiding Account existence and avoiding DB load on refusal. Overload can mask DB errors and slow lookups reduce utilization.
- #340 glibc mmap threshold frees Argon2 blocks. Re-measure on libc change. Trixie #513 verified RSS only.
- #146 opportunistic cleanup keeps global Sessions off a per-Organization job (#53/#73) or scheduler. Tight deadlines limit interference.
- #196 idle eviction avoids global lockout. Churn/eviction and restart reset failures. Fixed windows allow twice the budget at boundaries. Email limits distributed guesses but allow one-window targeted lockout. The other map and Argon2 bound work without durable Account protection.
- #194: forwarded IPs require a trusted peer and configured header. Rightmost selection trusts only the append hop. [Deployment](../spec/deployment.md#proxy-and-sign-in-limits)
- #194: require a nonblank FUKULOW_SETUP_TOKEN in every mode to prevent pre-Owner claims. Keep extraction before constant-time token verification and document/test its generic errors instead of rewriting the handler, since those errors reveal neither token nor bootstrap state. Public status lets web choose setup or sign-in. After token and input validation, check global existence without a lock before hashing and recheck under the Organization table lock for races.
- #194: Compose separates proxy/app edge from app/DB backend. Derive addresses together and trust the fixed proxy IP only because gateway/subnet trust includes the host path.
- CI probes health through Caddy HTTPS and nginx HTTPS with Pebble (#469). Main/manual adds WSS, renewal and cert reuse. Public-domain checks are manual.
- #144 centralizes deny-by-default authority and SQL Role sets. Version the Organization lock row to abort stale REPEATABLE READ updates before using an old Owner count.
- #303 lists range over unconsumed expiry, sort live rows and recheck the clock. Creation-order indexing prolonged locks by scanning expired history in generic plans. [Baseline](../measurements.md#invite-list-expiry-range-303)
- #303 management follows invited-Role policy regardless of issuer. Pre-fill filtering and uniform 404s hide counts/email. Lock with acceptance to serialize irrevocable revocation.
- #223 separates the Owner-Role Invite quota because Admins cannot see Owner-Role counts. Admin creation outcomes depend only on the shared non-Owner-Role pool. Within caps the live sort covers at most 110 Owner or 100 Admin candidates; above-cap rollout stock is not bounded ([cost](../measurements.md#invite-list-expiry-range-303)).
- #303 retains random UUID cursor anchors scoped by Organization/Invite/Role to prevent foreign reuse without keys/tables. #223 moves anchors and keyset boundaries to tombstones atomically so deletions cannot cause paging skips. Bounding tombstone growth by expiring cursors requires a separately approved spec change.
- #144 uses seven-day Invites and stores only SHA-256 of the 256-bit token. Authenticate Accounts instead of trusting email equality. Recheck issuer under Organization lock so old Invites cannot bypass lost authority.
- #293/#314 RLS USING/WITH CHECK require transaction-local Organization as the app role, alongside SQL scope and authorize. Unset fails closed. Global credentials/Sessions, own-Member SELECT, boolean setup definer (#334) and owner jobs (ENABLE without FORCE) are narrow exceptions. Direct EXISTS would miss hidden Organizations. Verify as app role and compare hot paths.
- #314 helpers own BEGIN/context/cleanup. Discard unconfirmed connections even before BEGIN acknowledgment. Reapply restricted definer EXECUTE after no-ACL restore. Writes and multi-read snapshots use transactions.
- #314 single-statement hot reads use materialized context CTE before non-flattened LATERAL to save three round trips. This covers Channel visibility, member_access, single-batch access_rows, replay pages and the send barrier (fresh watermark snapshot). Revert any path to transactions unless isolation holds across plan modes, scope, reuse, unset and cancellation (#334).
- #151 maintenance enumerates one Organization UUID per minute with wraparound. Bounded local-RLS reclamation needs no traffic or global tenant data access.
- #151 DM access needs participation and current grant to preclude third-party access and Role bypass.
- #151 explicit non-Guest open resolves already accessible DMs before peer eligibility for safe lost-response retries. The renewal branch replaces lapsed grants atomically and preserves current ones; reactivation restores nothing.
- #151 peer eligibility belongs to new sends and create/renew, preserving active peer history/mark-read at offboarding.
- #294 A (#315) limits Guest discovery to shared grantees and uses readable authors (#301) to resolve past names without widening access.
- #305 Owner may deactivate another active Member and Admin only non-Owners. Authorize before disclosure and check target before guards to prevent leaks/self-lockout.
- #305 owns the deactivation transaction and post-COMMIT signal in a detached task so cancellation cannot lose 4003.

## Password and other Sessions (#304)

- #304 PUT /api/v1/me/password takes the current password as does revoke-others. Keep the current Session so users can secure an Account without losing access.
- #304 wrong current password is 403 current_password_incorrect because clients end their Session on 401.
- #304 recheck current Session/password under locks. One admitted worker verifies and hashes the replacement, avoiding a second queue admission while holding the Account lock. Lock Account before sign-in verification so it cannot escape revocation. Detach the transaction and post-COMMIT signals so HTTP cancellation cannot lose 4001.
- #757 (decided 2026-11-22, not yet implemented): password change and revoke-others, which both verify the current password, leave the sign-in IP/email budgets for their own per-Session and per-Account failure budgets (Account: provisional 5 per 60 s). Third-party sign-in failures can then no longer block an authenticated Account holder. Trade-off: guesses per Account rise from 5 to 5 (sign-in) + 5 (authenticated) per window, and a stolen Session's failures still use the Account budget, so the Session's holder (not an unauthenticated attacker) can block the Account holder for a window. Argon2 admission, error responses and the lock/revocation rules above are unchanged. Denial tests: same IP, multiple and stolen Sessions, cross-Organization, revoked Session.

## Sessions and revocation

- #149 channel_access_lost carries only channel_id, keeps the socket open and retires the subscription without retained notice state. [Fallback grant checks](../spec/realtime.md#real-time-sync-contract)
- #149 observed loss fences queued/replay frames and subscribed at first poll under the status guard.
- Two independent revocations: ending an Account Session signals token hash globally (4001). Membership loss signals Organization/Account plus revision (4003) (#146).
- Revocation boundary: history/replay deny once revocation commits. Earlier snapshots may finish without later Messages. Live observation serializes with handoff. In-flight frames may finish (#146, #149).
- #57 PR C/#157 bounded process-local fallback deduplicates Organization/token hash with no Session-count cap. Whole pass must succeed to apply revocations. Failure closes snapshot.
- Classification precedence: known Account Session end (4001), Membership loss (4003), then DB/worker failure (1011), including admission latches (#146).
- Open sockets use the database expiry clock and immediate signals. Lagging receivers fail closed 4001 (#18).
- The initial WebSocket session check is capped at 5 s. DB failure is 1011 to distinguish ended Sessions (#57 PR C).
- #157 supervises the worker: any unexpected exit latches unavailable, signals 1011 and refuses admission. Fresh SQL can recover failed unrevoked epochs.
- #163: after an unexpected worker exit exit(1) after 2 s so Compose restarts it. Healthcheck alone cannot. HTTP outcome may be unknown. Recover via same client_message_id and #135 replay. No automatic retry or Close delivery guarantee.
- #163/#195: successful return after registry drop or explicit pool close is normal. Drain HTTP/sends/notices/sockets first. Panic/cancel stays fatal.
- #163 manual check: node scripts/check-compose-restart.ts verifies Compose restarts the actual main process.
