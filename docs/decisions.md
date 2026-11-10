# Decisions

Current decisions only: what + why, at most 300 characters each; details in the linked Issue/PR. Superseded entries were removed in #175 and raw measurement records moved to `docs/measurements.md` (#182); the full former text is at [5023c62](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md); #178 measurement tables at [2599d3b](https://github.com/tkakkie/fukulow/blob/2599d3b9c0e79f336b5726c6f6fbbc31e5db08da/docs/decisions.md).

## Product, stack and delivery
- Rust + PostgreSQL + WebSocket; Svelte SPA embedded in the binary. Reason: performance, one-image delivery.
- Reverse proxy is optional: the app speaks plain HTTP; Caddy (default) or nginx via compose profile. Reason: Caddy gave trouble in ribbitto and may limit performance.
- OpenAPI generated from Rust, committed, diff-checked in CI. Reason: future native clients (Kotlin).
- `organization_id` on every table from day one. Reason: multi-organization later without retrofit.
- Public repo. Reason: free CI minutes.
- Migrations run at startup before listening. PostgreSQL 18 persists under `/var/lib/postgresql` (its new data path).
- Deployment is single-process: live delivery, revocation, throttles and admission are process-local. Multiple server processes need shared publication/revocation and a shared limiter first (#18, #57).
- A second instance blocked on the migration advisory lock past the 5 s timeout fails startup and relies on Compose `restart: unless-stopped` to retry (#88, #93).
- PostgreSQL 17+ is required (`transaction_timeout`); on older servers every send/subscription fails loudly. Compose and CI use 18; no startup check (#158).
- Dependabot security updates were enabled on 2026-11-08 but no security PR has been seen, so do not claim they work. VPS automatic OS security updates are planned with the deploy work.

## Rules, CI and AI process
- Rules have tiers: Absolute (CI only with a reliable check), Default (deviation needs a PR line), Free. Reason: hard rules without a good check push AIs into awkward code; boundaries and tenant isolation are worth enforcing (#29).
- One crate with module boundaries, each module owning its tables. Reason: cross-crate refactors are costly for AI-driven work; revisit when build time, dependencies or conflicts hurt.
- #200 adds `docs/ui.md` as a doc kind for web UI rules. Reason: several AIs build screens in parallel; one short rule set keeps look, states, focus and copy consistent without re-deciding per PR.
- Minimal docs. Reason: AI credit cost. `AGENTS.md` holds always-needed rules, `docs/workflow.md` procedures that change more often, so an AI keeps going alone and stops only on a human decision (#101, #174).
- `organization_id` exemptions and why: `organizations` (tenant root), `_sqlx_migrations` (SQLx bookkeeping), `accounts` and `account_sessions` (global Account data). The same names in another schema are not exempt.
- Schema guard discovers migrations at test runtime so cached binaries cannot miss new files. The append-only check compares with the PR base or previous main commit, with rename detection off so moves cannot hide deletions (#31, #40).
- Lints forbid `unsafe` and deny `unwrap`/`expect`/`panic!` outside `#[cfg(test)]`; negative compilation fixtures use the real manifests and Clippy config to guard enforcement and test exclusions (#32).
- gitleaks runs as a SHA-pinned Action on PRs and main, with full history on the first run, to guard secrets in the public repo.
- Module direction is a rustc-driver check of resolved paths, macros, type-dependent calls and fields (#46). Rejected (#32): a deprecated-attribute probe missed a forbidden path re-exported through a non-deprecated item.
- #80 adds inferred expression/binding types to the module-direction check (#66 option 2). Rejected option 3: tracing root fn/impl bodies would flag legal uses such as tests calling `crate::app(AppState{..})`.
- Module direction stays review-enforced for values forwarded through root fields/functions and root nominal wrappers (#66 (b)); generic/trait dependency injection and lower/same-level `AppState` fields must stay allowed.
- The module-direction checker uses unstable `rustc_private` (`rustc-dev`, `RUSTC_BOOTSTRAP` scoped to the checker). Every toolchain bump must rebuild it, verify its APIs and run all fixtures; a bump that breaks it is not merged (#46, #80).
- #80 cost: no measurable check-time regression (median 1.74 -> 1.68 s); the added `rustc_private` surface is a small accepted maintenance increment.
- Invariants check (#47): a reference counts only if CI runs that test; refused and undetected cases are listed in the header of `web/scripts/check-invariants.ts`. Rust references are reconciled with `cargo test -- --list` in the CI server job (#69).
- Web boundary check (#48, #60): Workers/SharedWorkers and `?worker` imports are network uses allowed only in the API layer (they can hide communication). Known limits are in the header of `web/scripts/web-boundary.ts` (#60).
- Web storage is forbidden everywhere. A future `src/ui-settings.ts` exemption must land with its guard: typed allow-list of keys and values, no free-form key or string value, tests that invalid ones cannot be stored (#48).
- Hand-written API types are review-enforced, not CI: TypeScript is structural, so a same-shaped copy still type-checks, and an AST check cannot judge semantic duplication. Promote only with few false positives/negatives and a negative test (#49).
- AI models: Codex sol/medium by default, high on H1-H6; astra reviews (high for round 1 of risk:needs-review or gate changes). Adopted after comparing ribbitto's policy and public comparisons; revisit if results disagree.
- k6 bumps are manual (Dependabot does not see `K6_IMAGE` in Makefile): keep the exact tag, type-check and smoke-test each bump; `@types/k6` versions need not match runtime; digest pinning deferred (#20).

## API contract
- `make api` exports the contract without a database; `openapi-typescript` is pinned in an isolated npm environment because its TypeScript 5 peer conflicts with the SPA's TypeScript 6.
- #23 published REST and `ClientMessage`/`ServerEvent` types before runtime work. Message pages: `after_seq` XOR `before_seq` (neither = latest), limit 50 default / 200 max, always ascending seq; `has_more` follows the queried direction.
- `ListMessagesQuery` keeps every field optional in the shared schema; the limit default (50) lives only on REST query metadata so generated TypeScript accepts an omitted limit. Both keep min 1 / max 200.
- WebSocket messages are serde-tagged `oneOf` with discriminator `type`, registered as schema roots; utoipa variants are lifted into named components for discriminator references. WebSocket auth never uses a query-string token.
- Request bodies are capped at 16 KiB; only the Message send route allows 32 KiB (a 4,000-scalar body is up to ~24 KB JSON-escaped) (#17). Extraction errors map to `ErrorBody`: 400 invalid, 415 content type, 413 size.
- WebSocket runtime promoted the existing serde_json to a production dependency; test-only tokio-tungstenite and futures-util reuse locked packages to exercise real upgrade/frame/close; no new locked packages (#18).

## Auth, Accounts and tenancy
- #146 splits global Accounts and Account Sessions from Organization Members. Authority is the Account plus the Organization URL on each request. Documented global operations: setup existence, credential/session lookup, active-Organization listing, Session cleanup.
- Non-Member, unknown Organization and deactivated Member return the same 404 `organization_unavailable` so Membership is not disclosed (#146).
- Web cookies and native bearer share one opaque random 256-bit credential; only its SHA-256 hash is stored. 30-day expiry; sign-out revokes both. Cookies HttpOnly, SameSite=Strict, Secure (`FUKULOW_COOKIE_SECURE=false` only for local HTTP).
- Password hashing uses Argon2id on at most four blocking workers to bound memory.
- Account Session cleanup is opportunistic: one global 1,000-row expired batch per permitted minute, single flight, 2 s deadline / 1 s statement timeout; no scheduler (#146, replacing the #53/#73 per-Organization design).
- #146 migration refuses duplicate lower(email) across Organizations and reports all of them; it never merges Accounts or compares password hashes. Old sessions are dropped; users sign in again (no compatibility path).
- Deactivation is `users.deactivated_at` (NULL = active). Member rows are never deleted and their Organization/id/Account cannot change (DB triggers), preserving historical senders; UNIQUE (organization_id, account_id) (#146).
- Reactivation never restores old private Channel permissions: grants capture `membership_revision`, access needs the current revision, and a trigger bumps it on every deactivation, even via direct SQL (#146). Re-grant goes through #149.
- Auth resolves the Account Session and optional active Member in one LEFT JOIN (no Session: 401; no Member: 404). Member SQL stays in `auth` as composable scoped fragments (#146 review).
- Sign-in throttle, process-local 60 s windows: 20 failures per IPv4 or IPv6 /64 (IPv4-mapped shares IPv4), 5 per normalized email; in-flight attempts reserve capacity before Argon2; only failed credentials persist.
- Throttle maps hold at most 10,000 keys: idle IP buckets are evicted oldest first (admitting new clients over keeping history); active reservations never; a map full of reservations, or a full email map, refuses with 429 + Retry-After.
- Forwarded client IPs are ignored unless both an exact proxy-peer allowlist and the header are configured; then the rightmost IP appended by Caddy/nginx is used, else the socket peer.
- Accepted throttle tradeoffs: the per-email budget lets anyone lock a known Account for up to one window (limits guesses across IPs); fixed windows allow up to twice the budget across a boundary; restarts reset limits.
- Optional `FUKULOW_SETUP_TOKEN` gates setup with a constant-time digest compare and generic 401; set it before public exposure. Unset keeps bootstrap; an empty value fails startup.
- Setup body extraction stays before token verification: extraction errors are generic and reveal neither the token nor bootstrap state; documented and tested instead of rewriting the handler.
- Setup checks Organization existence without a lock before Argon2 work (after token and validation); the locked transactional check stays authoritative for concurrent bootstrap.
- `GET /api/v1/setup` is public and read-only, returning only `setup_required` with `no-store`, sharing POST setup's single `SELECT EXISTS`, so the web can choose setup or sign-in.
- CI probes health through Caddy HTTPS (local certificate verification off) to exercise proxy routing and TLS startup.
- Cookie WebSockets require one matching Origin: same Host over HTTPS (HTTP when cookie_secure=false) or `FUKULOW_WS_ALLOWED_ORIGINS`; forwarded headers never decide it. Origin is checked before Auth and Organization parsing; Bearer needs no Origin.

## Channels and Messages
- Private Channel creation adds the creator in the same transaction; composite FKs bind memberships to a Channel and Member of the same Organization. Listing is one scoped query, `no-store` (#22).
- Inaccessible Channels return the same 404 for reads and sends, so private Channels are not disclosed (#17).
- Channel names are unique per Organization across visibility, `lower(name COLLATE "C")` (ASCII folds, non-ASCII as-is); duplicates 409. Existing duplicates fail the migration for the operator to resolve; no auto-rename (#51).
- Accepted (#51): a 409 on creation lets an Organization Member infer a private Channel name exists (names only, no members or messages).
- Channel names are at most 128 Unicode scalars (Rust and PostgreSQL CHECK, OpenAPI `maxLength`), 400 before a write transaction. Reason: keeps 4-byte names inside the unique btree entry limit; generated TS cannot enforce it (#63).
- #63 migration never truncates, renames or deletes names; a violation aborts deployment. Before deploying, stop Channel writes and run `SELECT organization_id, id, name FROM channels WHERE char_length(name) > 128`; resolve, re-run until empty.
- #63 accepted lock: the plain CHECK validates rows under ACCESS EXCLUSIVE during ALTER, also blocking reads; acceptable at current scale.
- Channel names with leading/trailing `str::trim()` whitespace are rejected (400), never trimmed: trimming changes what was typed, invisible differences allow look-alikes (#72). Checked in the API, not a DB CHECK: PostgreSQL whitespace differs from Rust (#77).
- Per-Channel seq comes from a messages-owned counter row updated in the insert transaction, not a PostgreSQL sequence, so a rollback consumes no number. Cost: it serializes writes to a hot Channel (#17).
- Idempotency key (organization_id, sender, client_message_id): a match returns the canonical Message, a different body/Channel 409; a concurrent duplicate rolls back its allocation before reading the winner (#17).
- Message body: 1..=4000 Unicode scalars (the spec sets no limit), no NUL, not whitespace-only, never trimmed (whitespace counts for idempotency); 400 before seq allocation (#17, maintainer-approved).
- Sends re-check Member/revision/private grant after BEGIN and hold a shared Member row lock through COMMIT, so deactivation cannot commit between authorization and persistence. Channel creation keeps the same lock (#146 review).
- History reads authorization and its page in one read-only REPEATABLE READ transaction without row locks: loss committed before the snapshot denies; an authorized page sees no later Messages (#146).

## Real-time delivery
- Subscribe handoff: register live first, replay committed seq > cursor in 50-Message pages, flush newer queued events, then send `subscribed`. Clients dedupe by (channel_id, seq): duplicates allowed, no gaps (#18).
- Full queues close with 4008, never silent loss; clients reconnect from each Channel's last seq. Per connection: 256 queued events, at most 256 subscriptions (#18).
- Messages owns post-commit fan-out; Channels owns visibility. Fan-out checks all candidate Members in one visibility query (no per-recipient SQL) and shares canonical payloads; authorization-query failure closes with 4008 for replay (#18).
- Message persistence and sign-out finish regardless of HTTP cancellation, so a commit cannot skip notification (#18).
- Future subscription cursors are clamped to the committed high-water seq so clients resume live delivery after a database restore (#18).
- One shared FIFO queue per connection: an accepted subscribe sends `subscribed` only after every event queued before it, across Channels (used by contract silence barriers). Not a cross-Channel order guarantee; preserve or replace with its proof (#116).
- #57 PR B: notification runs detached after COMMIT; HTTP awaits persistence only. A guard armed before COMMIT makes an incomplete task signal that Organization/Channel's sockets to close with 1011, so reconnect replays (no durable queue).
- #179: notifications reserve at most 40 tasks per Organization/Channel and 2,048 per Delivery before spawning. Publication takes one of 40 global execution permits only after the cursor lock; saturation latches 1011. HTTP never waits on notification capacity.
- #179 chooses separate bounded cursor-wait reservations over coalescing to preserve hot-Channel admission and recovery behavior. The 2,048-task ceiling bounds retained work across Channels; the 10 s deadline still includes cursor waiting, and Drop frees reservations on every exit.
- #190 chooses 512 reservations/Organization over 256: both preserve B in the controlled probe; 512 gives twice the temporary many-Channel headroom while leaving 1,536/2,048 slots beyond any one Organization. A conservative bound, not an optimum.
- #190 counts reservations under one short mutex for acquisition and final removal, avoiding stale-entry races. Each guard retains its global permit until after removal, bounding Organization entries to 2,048; no async wait or publication lock is added.
- Authorization reads `channels.visibility` fresh on each REST/replay check and fan-out; nothing is cached or carried from HTTP into fan-out, so a committed visibility change is seen next. Public costs one boundary query (#57 PR B).
- #135 ambiguous-COMMIT recovery: persistence takes a scoped transaction advisory lock exclusively before COMMIT; watermark reads take it shared, then read in a separate READ COMMITTED statement, so replay recovers every committed Message without a later send.
- #135: outcome lookups cannot prove rollback from absence, so they are not used. Each watermark is bounded to 10 s including pool acquisition; an unresolved outcome closes that socket with 1011. Cost: one extra statement per send.
- #135 suppresses 1011 only for COMMIT errors known to roll back: SQLSTATE class 23 and 40000/40001/40002/40P01. I/O, shutdown, 40003 and timeouts (incl. 25P04) stay conservative.
- #147 watermark: a materialized `set_config('lock_timeout', ...)` CTE precedes the shared lock in one statement (5 -> 4 round trips); the counter SELECT stays separate to keep #135's fresh snapshot.
- #57 item 4: fan-out snapshots recipients under a per-Channel mutex; the global registry only hands out counted Channel leases. One publication cursor per Channel recovers missing committed Messages once in 50-Message pages and reauthorizes each page.
- #57 item 4 evidence: under a forced reorder with 128 sockets, SQL fell from 779 to 12 statements (no per-socket refills). Item 6 (fixed offered-load comparison and queue caps) is #178.
- #57 item 4: `auth` owns the active-Member predicate; `channels` owns one public/private grant predicate and query builder. Reads, subscribe, replay and fan-out are non-locking; batched candidates are bounded by `id = ANY($3)`.
- #173: shared recovery covers at most one 50-Message page (also bounded by the 256 queue). A larger gap latches Channel failure (1011) and advances the cursor; replay itself stays paginated without this limit.
- #173 safety: subscribers before the latch keep their failed epoch and reconnect from their cursor; later ones register live before the barrier-protected watermark. Cursors discard overlap: ascending at-least-once, no omissions while authorized.
- #173: each recovery page re-queries visibility. Authorization-query failure sets overflow (4008) for that snapshot and advances; a page-read failure latches 1011 and keeps the cursor. Both fail closed and recover through replay.
- #136 notification failure uses one watch per latched Organization/Channel epoch: the HTTP failure path is one lookup, swap and at most one spawn, with no recipients lock, subscriber iteration or inline wake-up.
- #136 evidence: idle CPU at 10,000 sockets fell from ~58% to ~3% of one core. 1011 bulk-close median rose (~120 -> ~157 ms), a same-runtime scheduling artifact of waking 10,000 tasks at once, not a shown production regression.
- #136: each socket owns one failure-monitor task (abort-on-drop) and awaits its oneshot in a `biased` select, keeping 4001/4003, then 4008, then 1011 priority. Outside a Tokio runtime `Signal::fail` keeps the latch and skips the wake.
- Ping every 30 s; the first Ping after the last client frame starts one 60 s grace, so an idle unanswering socket closes with 1001 after ~90 s. Reason: keeps idle sockets exercised without frequent traffic at 10k sockets (#57 item 5).
- Heartbeat uses the existing loop's single interval (no task, no env setting). All frame writes share the 5 s send deadline (4008 on timeout, 1001 on write error). Client Close is answered within 1 s (#57 item 5).
- #148 separates two responsibilities: (1) gapless `seq` allocation (the counter row update, order within a Channel); (2) the #135 commit/watermark barrier (readers may trust every `seq` <= W is committed). Neither provides the other.
- #148 fixtures for behaviour not implemented yet are marked `proposed` with an owner Issue: validated, skipped and listed by runners; planned vocabulary fails validation elsewhere. Membership-check fixtures are controller-layer: the pure protocol has no I/O.

## Topics, Replies and Unread (planned, spec P1-P8)
- A Topic is created by its first Message (or a Move to a new Topic); empty Topics do not exist. The main-timeline Topic line is a derived display that moves with the Topic's latest activity (maintainer, 2026-11-10, #148).
- Main-timeline paging correctness (`position_W`, W as page anchor) is fixed in the spec; its cost is a measured feasibility gate in #137 that stops and asks on a miss, not a guarantee (maintainer, 2026-11-11, #148).
- Topic counts are an as-of-W baseline plus deduplicated live Messages with `seq` > W; a Topic seen only live has no count until a summary fetch. Reason: replay below W or late older pages must neither double-count nor drop the baseline (#148).
- Unread keeps a Channel position (Messages without Topic) and per-Topic positions; badge = sum. Initial position = latest committed `seq` when the Member gains access; older history is not unread (maintainer, 2026-11-11, #148, #142).
- Move, Edit, Delete (principles only, #148): clients apply entries idempotently; a later change takes a Channel log position. Open: replay of a changed Message (current or as it was), of a deleted one, read positions after a Move. `channel_events` vs `channel_log`: Sprint 3 (#160).
- DM will be a Channel kind, so it reuses `seq`, the sync contract and Unread. Mention gets its own counter, separate from Unread (#148).

## Sessions and revocation
- Two independent revocations: ending an Account Session signals its token hash in all Organizations (4001); Membership loss signals (organization_id, account_id) with its new revision (4003), leaving other Organizations alone (#146).
- Revocation boundary: history/replay deny once revocation commits; live delivery starts no new protected frame after the check sees loss, but frames already in flight may arrive. Commit never retracts an in-flight frame (#146, #149).
- Fallback worker: one process-local worker checks all distinct session keys every 30 s in 1,000-key batches under one 5 s deadline; a lost signal is detected within 35 s. Only a fully successful pass revokes; any failure closes the snapshot with 1011 (#57 PR C, #157).
- No session-count cap on the fallback pass: 100,000 distinct sessions passed in ~0.25-0.33 s, well inside the 5 s deadline (#157, #146). De-duplication is by Organization/token hash, not socket count.
- Classification precedence: known Account Session end (4001) wins over Membership loss (4003), which wins over database/worker failure (1011), including signals latched before socket admission (#146 Copilot).
- Open sockets use the database expiry clock plus immediate revocation signals; a lagging revocation receiver fails closed with 4001 (#18).
- The initial WebSocket session check is capped at 5 s (was the 30 s pool default); a DB error there closes with 1011, reserving 4001 for ended sessions (#57 PR C).
- #157 supervises the worker: any unexpected exit latches unavailability, signals 1011 and refuses new WebSocket admission. A failed non-revoked registration gets a fresh watch sender; revoked epochs are never replaced.
- #163: after an unexpected worker exit the process exits(1) after a fixed 2 s grace so Compose `restart: unless-stopped` restores service. Rejected: a healthcheck alone, because Compose does not restart unhealthy containers.
- #163: only a return with the registry gone or the pool explicitly closed is a normal exit; `main.rs` never closes the pool today. Revisit when graceful shutdown closes it while HTTP keeps serving.
- #163 exit cuts in-flight HTTP; outcomes may be unknown. Recovery is an idempotent retry with the same `client_message_id` plus #135 replay; no automatic HTTP retry and no Close-frame delivery promise.
- #163 manual check: `node scripts/check-compose-restart.ts` verifies `restart: unless-stopped` after killing the real main process (host-PID helper when in-container SIGKILL is ignored); Rust tests cover the panic path.

## Admission and timeouts
- #88 bounds startup migration lock waits with session-local `lock_timeout = 5s`, including SQLx's advisory lock. Reason: queued exclusive DDL can stall later reads/writes; fail before listening instead of waiting. No automatic retry.
- Connection budget `min(16, pool_max - ceil(pool_max / 5))` keeps at least 20% of the pool outside sends and watermarks. A trial cap of five rejected startup subscriptions; 16 passes the burst (#147).
- The budget is partitioned (#156, #158): sends round up, watermarks round down (8 each in production), no borrowing; per Organization/Channel at most one send and four watermarks. No per-Organization DB admission reservation.
- #156 chose bounded admission outside the pool over short-wait or try advisory locks: a DB lock wait still holds a connection, and try-lock turns normal contention into repeated 1011/reconnect and send failures.
- Watermark admission waits at most 1 s; send admission 30 s (a queued send holds no connection), then 10 s persistence work, so a send response is bounded by 40 s. Session and Channel authorization still come first (#156).
- The exclusive barrier precedes counter allocation with transaction-local `lock_timeout=10s` and `transaction_timeout=8s`, so PostgreSQL ends stuck work before the app's 10 s deadline; prevents leftover COMMIT backends/locks (#158).
- #158: the owned transaction holds Channel and budget permits through COMMIT/ROLLBACK with explicit BEGIN/COMMIT; on error, cancel or deadline its Drop detaches and drops the connection instead of awaiting close behind a stuck COMMIT.
- Exactly one Delivery per application pool (shared by its clones) sizes the budget once; only Delivery exposes watermark access outside `messages`. A stuck Channel holds at most four watermark and one send connection (#156).
- `transaction_timeout` starts only at the barrier: pool acquisition and the initial canonical lookup come first, so up to 8 s of server work can outlive app abandonment; not an absolute HTTP bound. No prepared transactions (#158).
- Socket abandonment does not prove rollback (PostgreSQL may still COMMIT), so #135's shared barrier, current authorization and canonical same-key retry stay necessary (#158).
- #161 caps queued send waiters at 256 per Organization/Channel and 2,048 globally, reserved before spawning. #178 kept these values; one Organization can still consume all global slots.
- #161: queue-cap rejection and 30 s admission expiry return 503 `ErrorBody` with a random 1-5 s Retry-After (shared saturation, so not 429). DB failures, unknown COMMIT and the 10 s work deadline stay 500/unknown outcome.
- A dropped connection or response timeout is not evidence of non-persistence (detached work may run 30 s + 10 s): clients retry with the same client_message_id, never a new key (#158, #161).
- Admission rejections log `admission_rejected operation=watermark|send scope=channel|global organization=... channel=...` to stderr, unthrottled for now (counters/rate limiting deferred); no logging dependency (#156).
- Admission is a bounded-wait guard, not a dedicated HTTP pool: auth, history, replay and notification share the same pool (#156).
- Known limits for the 10k target: FIFO budgets can delay unrelated Organizations; four watermarks per Channel cap popular-Channel reconnects (~1,000/s at ~4 ms each); 10,000 simultaneous reconnects need client backoff (#156).
- #178 keeps send queue caps 256/2,048: smaller caps raised refusals; larger ones roughly doubled accepted HTTP/delivery delay with no shown capacity benefit; RSS did not discriminate. A conservative choice, not an optimality or fairness claim.
- #179 isolates held cursor waiters from execution capacity. #190 prevents only one Organization monopolizing reservations; simultaneous multi-Organization exhaustion and contention for the 40 shared execution permits remain. No cross-Organization fairness guarantee.
- Pending maintainer decision (#158 N1): two stuck Channels with 4+ reconnecting subscribers each can fill all 8 watermark slots; lowering the per-Channel cap to 2 would trade popular-Channel reconnect throughput.

## Web client
- #91/#94 real-time sync contract: OpenAPI types cannot express delivery/reconnect, so it lives once in `docs/spec.md` (server guarantees with tests; client rules as target). C8 excludes restored history past the old cursor; a history-generation id is deferred.
- Web sync is layered (components, adapter, controller, pure protocol, API/transport) so ordering and dedup are testable without Svelte or I/O; only message sync has a protocol (#91/#94). No CI layer check yet (needs a negative test).
- Capabilities (`{allowed, reason?}` per operation) are added only when the UI must show in advance whether an operation is possible (#91).
- #120: an async `channel_not_found` carries no subscription generation; if it could belong to a retired or a pending subscription, the controller reconnects with backoff. Cost: one resubscribe of all Channels; other clients must do the same.
- #97 Svelte 5 adapters only read the controller and forward intents; `createSubscriber` carries change notifications, so state is never copied into `$state`. Session controllers live from Sign in to sign-out/4001/401/replacement, closed by the auth adapter.
- #146/#148 client classification: 4001 Sign in; 4003 terminal Organization unavailable; 1001/1011 back off and reconnect; 4008 reconnects with bounded retries. A rejected browser handshake never implies 4003 (`GET .../me` confirms).
- The auth adapter keeps Account/controller lifetime and Organization selection together (Tier 2 deviation) to avoid an unrelated abstraction in the #146 migration; sync policy stays in the controller/protocol.
- #200 layout A2 (rail, チャンネル column with トピック accordion, main card, closable right panel), picked by the maintainer from three mockups; surfaces split by tone and radius, not rules. Details in `docs/ui.md`.
- #200 navigation uses the History API and the existing SPA fallback, with no router dependency: one entry per view or panel layer so browser/phone Back goes up one level. URLs are hints; the API decides access.
- #200 drafts live in controller memory per target for the Account Session, never in web storage; theme and text size are the only planned `ui-settings.ts` keys (enum values, per device, #48).
- Sprint 1 web acceptance: `npm --prefix web run e2e:compose` against `docker compose --profile caddy up` from an empty database (#19).

## Load testing and measurement
- #20 load scaffold: `npm --prefix load ci && npm --prefix load run check && npm --prefix load test`; `make load` signs in to a disposable test Organization (`LOAD_EMAIL`, `LOAD_PASSWORD`; `LOAD_BOOTSTRAP=1` only for an empty DB). CI runs 5 sockets for 10 s.
- #57 PR A: a fixed offered rate replaces response-paced sends: `PUBLISHERS` sends every `PUBLISH_INTERVAL_MS`; a missed deadline fails the run instead of reducing or bursting traffic. Missing deliveries, gaps and unexpected closes fail; no reconnect masking.
- Compare before/after only with `make load-record` (isolated Compose project, dedicated PostgreSQL with pg_stat_statements, own cleanup, never the shared test DB), e.g. `CHANNELS=1 SUBSCRIBERS=20 PUBLISHERS=2 PUBLISH_INTERVAL_MS=100 DURATION_SECONDS=30` (#57).
- Report SQL per offered send as top-level queries, all statements and statements incl. nested FK checks; pg_stat_database is supporting evidence only. Keep raw artifacts outside Git; reuse identical conditions for comparisons (#57).
- #178 before/after: 6 -> 8 top-level queries per send is #146 Membership/revision authorization, not a hardening regression. The 10,000-socket HTTP p95 drop spans #134-#173 and #146, so it is not attributable to one change.
- #178 harness: `make load-record` with `LOAD_DIRECT_NETWORK=1` (port-forwarding failed at 9,990 sockets), `LOAD_SERVER_SOURCE` for the worktree, `LOAD_LEGACY=1` only for pre-#146 builds; short windows are rejected. Never attach the raw artifact directory publicly (server logs, source patch).
- Measurements so far are modest single-host runs: none establishes the 10k-connection target, a capacity or a latency guarantee. Heavy run: `CHANNELS=1 SUBSCRIBERS=10000 ... make load` with `nofile` 65536; one generator loop can saturate (#20).
