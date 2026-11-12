# Decisions: auth

Accounts, sign-in, tenancy, Account Sessions and revocation. Writing rules and the other parts: [index](../decisions.md).

## Auth, Accounts and tenancy
- #146 splits global Accounts and Account Sessions from Organization Members. Authority is the Account plus the Organization URL on each request. Documented global operations: setup existence, credential/session lookup, active-Organization listing, Session cleanup.
- Non-Member, unknown Organization and deactivated Member return the same 404 `organization_unavailable` so Membership is not disclosed (#146).
- #197 web POST /session returns only identity/expiry via HttpOnly cookie; native POST /native/session returns bearer JSON without cookies. Both share verification, issuance, throttle and DELETE /session revocation; only SHA-256 stored, 30-day expiry.
- #197 endpoint choice is explicit, never a flag or User-Agent boundary. The split limits accidental web token exposure but cannot fully prevent XSS: injected same-origin code can act as the user or call native sign-in with captured credentials.
- #197 HTTPS uses __Host-fukulow_session (Secure, HttpOnly, Strict, Path=/, no Domain); old fukulow_session is refused and expired on web sign-in/sign-out. Existing web users sign in again. Local HTTP alone keeps the old name (FUKULOW_COOKIE_SECURE=false).
- #197 migration deletes all existing Account Sessions, following #146: old web JSON exposed bearer credentials, so cookie expiry is insufficient. Every web and native client must sign in once after deployment.
- #197 FUKULOW_COOKIE_SECURE describes the public HTTPS serving path, including TLS proxies: it selects Secure cookies, CSP wss and default HTTPS cookie Origins. False is only for local HTTP; forwarded headers never select these policies.
- #197 app-wide CSP allows external same-origin scripts/styles and explicit ws(s)://Host, plus nosniff, strict-origin-when-cross-origin and frame-ancestors none on errors too. Validated Host preserves proxy ports; forwarded headers cannot widen CSP.
- #197 HSTS max-age=31536000 lives at TLS termination (Caddy; nginx $https map), without includeSubDomains/preload. Caddy skips localhost/loopback to avoid breaking other dev ports. Stock nginx is HTTP-only: its external TLS terminator must set HSTS.
- #197 Vite manifest outputs alone get one-year immutable caching; HTML, SPA fallback and unhashed files revalidate. API keeps no-store. Caddy zstd/gzip excludes /api and /api/* to avoid compressing secrets; stock nginx gzip covers HTML/CSS/JS/SVG, not JSON or WebSocket frames.
- Password hashing uses Argon2id on at most four blocking workers to bound memory.
- Account Session cleanup is opportunistic: one global 1,000-row expired batch per permitted minute, single flight, 2 s deadline / 1 s statement timeout; no scheduler (#146, replacing the #53/#73 per-Organization design).
- #146 migration refuses duplicate lower(email) across Organizations and reports all of them; it never merges Accounts or compares password hashes. Old sessions are dropped; users sign in again (no compatibility path).
- Deactivation is `users.deactivated_at` (NULL = active). Member rows are never deleted and their Organization/id/Account cannot change (DB triggers), preserving historical senders; UNIQUE (organization_id, account_id) (#146).
- Reactivation never restores old private Channel permissions: grants capture `membership_revision`, access needs the current revision, and a trigger bumps it on every deactivation, even via direct SQL (#146). Re-grant goes through #149.
- Auth resolves the Account Session and optional active Member in one LEFT JOIN (no Session: 401; no Member: 404). Member SQL stays in `auth` as composable scoped fragments (#146 review).
- Sign-in throttle, process-local 60 s windows: 20 failures per IPv4 or IPv6 /64 (IPv4-mapped shares IPv4), 5 per normalized email; in-flight attempts reserve capacity before Argon2; only failed credentials persist.
- Throttle maps hold at most 10,000 keys: idle IP buckets are evicted oldest first (admitting new clients over keeping history); active reservations never; a map full of reservations, or a full email map, refuses with 429 + Retry-After.
- #194: forwarded IPs require a trusted exact IP/CIDR peer and configured header. One field uses its rightmost IP; repeated fields or invalid rightmost IP use the socket peer. This preserves Caddy/nginx append semantics without trusting earlier hops.
- Accepted throttle tradeoffs: the per-email budget lets anyone lock a known Account for up to one window (limits guesses across IPs); fixed windows allow up to twice the budget across a boundary; restarts reset limits.
- #194: require a nonblank FUKULOW_SETUP_TOKEN in every mode and reject the former public example; ship an empty template. Cookie transport never exempts it. Constant-time digest compare and generic 401 gate setup. Never generate/log it, preventing public instance claims before the Owner arrives.
- #194: Compose separates proxy/app edge from app/DB backend, publishes only proxies and trusts the fixed proxy IP. EDGE_PREFIX derives subnet, gateway and proxy IP together; gateway/subnet trust would permit host-path spoofing. No dependency added for CIDR masks.
- Setup body extraction stays before token verification: extraction errors are generic and reveal neither the token nor bootstrap state; documented and tested instead of rewriting the handler.
- Setup checks Organization existence without a lock before Argon2 work (after token and validation); the locked transactional check stays authoritative for concurrent bootstrap.
- `GET /api/v1/setup` is public and read-only, returning only `setup_required` with `no-store`, sharing POST setup's single `SELECT EXISTS`, so the web can choose setup or sign-in.
- CI probes health through Caddy HTTPS (local certificate verification off) to exercise proxy routing and TLS startup.
- Cookie WebSockets require one matching Origin: same Host over HTTPS (HTTP when cookie_secure=false) or `FUKULOW_WS_ALLOWED_ORIGINS`; forwarded headers never decide it. Origin is checked before Auth and Organization parsing; Bearer needs no Origin.
- #144 uses one deny-by-default authorize function, including SQL role sets derived from it. Owner changes Roles/invites any Role; Admin invites non-Owners. Guests need explicit current grants even for public Channels; private grants remain required for every Role.
- #144 Invites bind email/Role for 7 days; SHA-256 of 256 random bits is stored. Existing Accounts authenticate; anonymous uniqueness conflicts require sign-in, never email attachment. Activation/consumption is atomic.
- #144 Invites retain their same-Organization issuer. Acceptance re-checks active Membership and current Role under the Organization lock using the creation policy, so demotion/deactivation cannot be bypassed with a stored Invite.
- #144 Owner transitions write-lock/version the Organization row; a DB trigger guards the last active Owner, including direct SQL. The MVCC write aborts stale REPEATABLE READ snapshots instead of trusting an old Owner count. No removal endpoint; #146 identity/revisions stay.
- #293 A (planned, #314): RLS is defense in depth on every organization_id table for fukulow_app (NOBYPASSRLS). USING and WITH CHECK compare organization_id to transaction-local fukulow.organization_id; unset fails closed. SQL organization_id predicates and authorize stay.
- #314 Organization access uses transaction-local authenticated/internal Organization context; Account identity uses verified Account context. SQL scopes and authorize stay. Fallback batches group by Organization.
- #314 Setup existence and its post-lock recheck stay global until step 4, which moves both to the SECURITY DEFINER function in the same change that enables RLS (#334).
- #314 context helpers own BEGIN, bound local settings and cleanup before/after a closure; send BEGIN accepts optional Organization context. Owned guards discard unconfirmed cleanup, including cancellation before BEGIN's response; production send callers supply their Organization.
- #314 single-statement hot reads use local context in a materialized CTE with a correlated, non-flattened LATERAL read: explicit BEGIN/set/COMMIT cost 3 extra round trips per read (subscription 13 vs 30 statements). Errors/cancellation discard; multi-statement snapshots stay explicit.
- #314 single-statement scope: one-statement Organization reads only (Channel visibility, member_access, single-batch access_rows, replay pages) and the send COMMIT-barrier watermark, which then reads seq in a fresh snapshot. Writes and multi-statement reads use explicit transactions.
- #314 single-statement risk: RLS safety depends on the materialized CTE running before the LATERAL read. Step 4 tests every use with production policies (custom/generic plans, Organization switch, reuse, unset, cancellation); any unguaranteed case reverts to an explicit transaction (#334).
- #293 (planned) exceptions stay narrow, never BYPASSRLS: accounts/account_sessions have no RLS; /me uses a SELECT-only policy for the caller's own Members; setup uses a boolean-only SECURITY DEFINER function; fallback rechecks run one transaction per Organization.
- #293 (planned) Owner jobs (migrations, pg_dump, restore drill) run as the superuser owner and bypass RLS by design; ENABLE without FORCE. RLS tests must connect as a non-superuser role, because CI tests connect as postgres. Merge needs before/after hot-path measurements.
- #294 A (planned, #315): a Guest lists only themself and active Members with a usable grant on a Channel the Guest can access; other Roles keep the full list. Sender names come from #301's author lookup scoped to readable Messages, never by widening the list.

## Sessions and revocation
- #149 channel_access_lost carries only channel_id, keeps the socket open and retires the subscription. The same fallback worker checks captured grant lifetimes under its 35 s bound; failed/overdue passes fail closed. No retained notification state.
- #149 observed loss fences queued/replay frames and subscribed at first socket poll under the status read guard. Only an already handed-off frame may finish; REST authorization/data snapshots established before COMMIT may finish without later Messages.
- Two independent revocations: ending an Account Session signals its token hash in all Organizations (4001); Membership loss signals (organization_id, account_id) with its new revision (4003), leaving other Organizations alone (#146).
- Revocation boundary: history/replay deny once revocation commits; live delivery starts no new protected frame after the check sees loss, but frames already in flight may arrive. Commit never retracts an in-flight frame (#146, #149).
- Fallback worker: one process-local worker checks all distinct session keys every 30 s in 1,000-key batches under one 5 s deadline; a lost signal is detected within 35 s. Only a fully successful pass revokes; any failure closes the snapshot with 1011 (#57 PR C, #157).
- No session-count cap on the fallback pass: 100,000 distinct sessions passed in ~0.25-0.33 s, well inside the 5 s deadline (#157, #146). De-duplication is by Organization/token hash, not socket count.
- Classification precedence: known Account Session end (4001) wins over Membership loss (4003), which wins over database/worker failure (1011), including signals latched before socket admission (#146 Copilot).
- Open sockets use the database expiry clock plus immediate revocation signals; a lagging revocation receiver fails closed with 4001 (#18).
- The initial WebSocket session check is capped at 5 s (was the 30 s pool default); a DB error there closes with 1011, reserving 4001 for ended sessions (#57 PR C).
- #157 supervises the worker: any unexpected exit latches unavailability, signals 1011 and refuses new WebSocket admission. A failed non-revoked registration gets a fresh watch sender; revoked epochs are never replaced.
- #163: after an unexpected worker exit the process exits(1) after a fixed 2 s grace so Compose `restart: unless-stopped` restores service. Rejected: a healthcheck alone, because Compose does not restart unhealthy containers.
- #163/#195: successful return after registry drop or explicit pool close is normal. Graceful shutdown closes the pool only after HTTP, sends, notifications and sockets drain, so fallback supervision does not exit(1); panic/cancel remains fatal even during teardown.
- #163 exit cuts in-flight HTTP; outcomes may be unknown. Recovery is an idempotent retry with the same `client_message_id` plus #135 replay; no automatic HTTP retry and no Close-frame delivery promise.
- #163 manual check: `node scripts/check-compose-restart.ts` verifies `restart: unless-stopped` after killing the real main process (host-PID helper when in-container SIGKILL is ignored); Rust tests cover the panic path.

## Entries in other parts

Entries that also govern this area, listed by the start of the entry in that part.

- [messages](messages.md): `#231 rejects Role demotion with 409`, `#149 API mutations lock Organization, Channels`, `Sends re-check Member/revision/private grant after BEGIN`, `#142 Messages owns read positions. Migration/grant`, `#142 access triggers serialize per Organization`
- [messages](messages.md): `#292/#311: a private`, `#292/#311 The right lives`, `#292/#311 last_channel_manager counts`
- [messages](messages.md): `#142/#144 triggers mirror Channel visibility, including`, `#144 Role/grant changes reconcile positions under`, `DeferredOrganizationAuth rejects Session/database errors before reading`
- [realtime](realtime.md): `Message persistence and sign-out finish regardless`, `#57 item 4: auth owns the`
- [web](web.md): `Capabilities ({allowed, reason?}) come from authorize:`

- [messages](messages.md): `#311 Target Member NO KEY UPDATE precedes`, `#311 Right-only updates skip Unread triggers`, `#311 The private-Channel trigger locks its Channel row`
