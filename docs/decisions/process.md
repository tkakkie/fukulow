# Decisions: process

Product, stack, delivery, project rules, CI and AI process. Writing rules and the other parts: [index](../decisions.md).

## Product, stack and delivery
- #408: Require a passing CI Playwright report for E2E invariants. Static checks cannot prove a test ran and still guard discovery.
- #198 B: pinned tracing/subscriber emit only reviewed `fukulow` events as stderr JSON. SQL/parameters, dependency logs and raw errors can expose secrets. Fresh request UUIDs and route templates avoid reflecting inputs. Ignore inbound IDs. Before tracing/runtime construction, replace the default panic hook with one that writes fixed JSON directly to stderr so even early payloads/backtraces stay private.
- #198 B: a domain-independent observability leaf owns fixed-bucket atomics. Emit approximate process-local totals at 60 s intervals with missed ticks skipped. No metrics route/service/storage.
- #426: Route all app checkouts through one measured atomic path, including former implicit executors. Emit 1 s cumulative wait and sampled occupancy buckets at DM budget edges. The production image measures the budget while declaring startup/owner exclusions.
- #373 Delegate test DB setup to SQLx and await registered app-pool closure before teardown, even on panic. Refuse unmanaged callers. Async Drop races DROP DATABASE and an admin-connection barrier starves single-connection tests.
- #477 Assert SQLx closes before bounded backend-exit waits. Socket/terminate has no server ACK. An exit-cleanup lock reproduces the race and an open-pool guard prevents the wait from hiding harness leaks.
- #198 A: Readiness coalesces and holds admission through bounded return to avoid unbounded SQLx Drop pings. Acquire/query/return get 200 ms each for local DB jitter and fast failure. Detach the connection on query error/cancellation. Use one FIFO slot without send/watermark permits.
- #198 A: Reuse the binary for a one-second HTTP probe because the image has no HTTP client. Add no dependency or port. Try resolved addresses and map wildcards to loopback. Separate runtime avoids stalled DNS shutdown. Proxies hide `/ready`. Unhealthy alone never restarts Compose.
- Rust/PostgreSQL/WebSocket and an embedded Svelte SPA serve performance and one-image delivery.
- #469 Caddy stays default. nginx uses the bundled official ACME package, matching image/package ABI pins and Pebble parity. A default change requires separate switch/rollback and measurement gates.
- #469 part 2 uses verified HTTPS to decide switch success, refuses accidental port changes and only restores a previously running proxy. A shared edge IP prevents overlap. Separate persistent volumes preserve each certificate. [Procedure](../spec/deployment.md#deployment-194-c)
- #194 C UID/GID 10001 and root-owned runtime files match network/DB-only access. Tag+multi-platform digest pins make external images reproducible. Dependabot checks Docker/Compose weekly. Review updates and cap per-container logs at 10m × 3.
- #401: deployment/load app and migrate use read-only roots, drop ALL capabilities and forbid new privileges. Embedded assets/SQL and DB-only persistence need no writable mounts. Check fresh stacks and populated upgrades.
- #194 C Exec-form CMD keeps PID 1. No init wrapper (no children) or STOPSIGNAL override (default SIGTERM). #195 registers SIGTERM/SIGINT before serving and drains work.
- #465 Rust owns native/web sync State to share policy without a separate KMP implementation. wasm-bindgen exposes deltas/bounded accessors. Generated, diff-checked OpenAPI still serves all clients.
- Require tenant `organization_id` up front to avoid a multi-Organization retrofit.
- Keep the repository public for free CI minutes.
- #194 B Separate owner credentials into one-shot `migrate`. App waits for success, validates versions/checksums/state and never migrates. PostgreSQL 18 persists under `/var/lib/postgresql`. Advisory/DDL waits stop at 5 s (#88, #93). The service does not restart automatically. On failure keep app stopped, resolve blocker and rerun manually.
- Single-process deployment keeps live delivery, revocation, throttles and admission local. Scale out only with shared publication/revocation and limiting (#18, #57).
- #195: shutdown also returns 503 for non-API paths (static/SPA). Those middleware responses are outside OpenAPI.
- #158 PostgreSQL ≥17 is required for `transaction_timeout` (older versions fail every send/subscription). Compose/CI use 18. No startup check.
- Dependabot security updates are enabled but have no verified security PR yet (#297). Automatic VPS OS security updates are planned for deploy.
- #194 B Shared initdb/roles SQL keeps `fukulow` as owner and updates `fukulow_app` without changing rows. Refuse memberships/ownership rather than reassign them. Suppress logs and nested stats transaction-locally before binding/quoting passwords, failing closed without settings rights. Owner defaults grant future DML/sequence USAGE. Normalize history to SELECT after migration, revoke PUBLIC CREATE/TEMP to prevent indirect trigger bypass and reapply grants after #198 no-ACL restore.

## Rules, CI and AI process
- #29 Absolute rules use CI only with reliable checks. Default deviations need a PR line. Other choices are free. Unreliable hard checks distort code. Boundaries/tenant isolation warrant enforcement.
- #373 Modules own their tables. Use more crates when responsibility, dependency direction, build time or testability justify it. Keep an acyclic DAG and one binary/image.
- #378 Staged split allowed and deferred: compiler-enforced responsibility/dependency boundaries must justify migration cost. Touch-only Mac rebuilds do not measure a split. Start with auth. Keep one crate and module-direction checker until revisit.
- #194 B: `database` is composition-level deployment/startup plumbing. CI enforces it as a leaf (#319, #328).
- #248 Read-only closures ROLLBACK on Ok/Err and reuse clean backends. Drop discards on cancellation or failed BEGIN/ROLLBACK. SQLx 0.8.6 sets depth after BEGIN responds and misses cancelled starts.
- #200 A shared `docs/ui.md` lets parallel UI work preserve look, states, focus and copy without re-deciding per PR.
- #101/#174 Keep docs minimal for credit cost. Keep always-needed rules in `AGENTS.md` and changing procedures in `docs/workflow.md` so AI work continues until a human decision.
- `organization_id` exemptions are `public.organizations` (tenant root), `public._sqlx_migrations` (SQLx bookkeeping), `public.accounts` and `public.account_sessions` (global Account data). Same names elsewhere are not exempt.
- #31/#40 Discover migrations at test runtime so cached binaries see new files. Compare append-only history to PR base/previous main without rename detection to catch moved deletions.
- #32 Forbid `unsafe` and deny `unwrap`/`expect`/`panic!` outside `#[cfg(test)]`. Negative fixtures use actual manifests/Clippy config to test enforcement/exclusions.
- SHA-pin gitleaks on PRs/main and scan full history on first run to keep the public repo secret-free.
- #46/#80 Rustc driver checks resolved paths, macros, type-dependent calls/fields and inferred expression/binding types (#66 option 2). A deprecated-attribute probe missed a forbidden path re-exported through a non-deprecated item (#32). Tracing root bodies (option 3) flags legal composition tests.
- #66 (b) Review values forwarded via root fields/functions/nominal wrappers. Permit generic/trait DI and lower/same-level `AppState` fields.
- #46/#80 The checker uses unstable `rustc_private` (`rustc-dev`, checker-scoped `RUSTC_BOOTSTRAP`). Every toolchain bump must rebuild, verify APIs and run all fixtures. Never merge a bump that breaks it. #80 accepted the added private-API maintenance after a timing check found no measurable regression.
- #47/#69 Invariants count only CI-run tests. `check-invariants.ts` documents refused/undetected cases. Server CI reconciles Rust with `cargo test -- --list`.
- Web boundary check (#48, #60): Workers/SharedWorkers and `?worker` imports can hide networking and belong only in the API layer. See `web/scripts/web-boundary.ts` for check limits.
- #48 Forbid web storage except the guarded `src/ui-settings.ts` exemption. It requires a typed allowlist forbidding free-form keys/values and negative tests that invalid keys and values cannot be stored. The exemption lands with its guard.
- Hand-written API types are review-enforced, not checked in CI. Structural TypeScript accepts copies and AST checks cannot resolve semantic duplication. Promote only with few false positives/negatives and a negative test (#49).
- #435 Credit limits keep sol medium, with high only for H1–H3/security. Reviews use Argon medium except astra medium for round 1 of risk:needs-review and Argon-authored changes. Do not use Argon high because of its quota bug. Hydrogen trials low-risk routine work. Carbon was dropped (#260). [Launch and review rules](../workflow.md#4-roles-models-effort)
- #275 Out-of-scope Copilot findings become follow-up Issues without blocking the PR, except for security, data loss/corruption, cross-Organization leakage, a serious PR-caused defect or unmet Done when. Limit credit cost: re-reviews on #273 found pre-existing gaps and added fix/CI cycles. Request Copilot once per PR. Request again only if clearly needed within two AI rounds total, even across reviewer changes.
- #275 Keep Argon as UI implementer. The ended #260 browser review trial found no additional defects, so web PRs get no extra browser review.
- #275 For credit cost, Issue-level AI review applies only to risk:needs-review. AI-decidable Issues (e.g. minor bug fixes, tests and docs) go directly to status:ready. Maintainer decisions go to status:human-review.
- #275 Pause new process improvements/doc rules until DM, Mention and Search merge to fund MVP work. Exceptions: security, serious defects, MVP blockers or explicit maintainer requests.
- k6 bumps are manual (Dependabot does not see Makefile `K6_IMAGE`). Keep exact tag, type-check and smoke-test. `@types/k6` may differ. Digest pinning deferred (#20).
- #295 A Use an explicit DAG instead of total order only after checking actual dependencies, table ownership and authorization boundaries. Preserve every existing checker capability and add allowed/denied/cycle fixtures. Separate checker and each module move into small PRs with no API/OpenAPI/WebSocket/authorization/DB access/Unread changes. DM #151 needs no prior move, so moves wait for a later Sprint.
- #319: CI enforces `database` and `shutdown` as leaves (#328). The four domain modules keep their existing edges to one another.
- #319 kept on purpose: Channel policy in `auth` (one `authorize`); predicates in `channels` (table owner); Unread triggers in `messages` (equivalence test); DI traits, not an `auth -> channels` cycle; GET /channels in `messages` (one Unread snapshot); `AccessChanges` in `Delivery` (M2 declined).
- #319 allows edges only when used. #328 added `auth -> database` (foreseen for #314, already used on main) and `realtime -> database` (maintainer, 2026-11-18). #607 removed the unapproved `channels -> shutdown` edge.
- #296 B 24 h RPO target measures newest verified off-VPS capture, not copy/verification. Backup/off-VPS copy/hash remain manual until #316 approval, retaining retention, secret custody/drills and alerts on failure or capture age ≥24 h. Defer WAL/PITR past #285 dogfooding. New external services or paid storage require maintainer approval of setup/cost before implementation. [Recovery window](../spec/deployment.md#recovery-window)
- #297 A Exact toolchains/images and lockfile-pinned libraries give reproducibility without manifest churn. Manifests may range except Playwright (must match its image). Resolved changes require reviewed PRs.

- #316 Preserve image originals for download and backup retention. Cut optimized variants or regenerable data, improve compression, then seek paid approval or move provider.
- #316 Separate backup/image buckets and credentials. age ciphertext, curl SigV4 PUT/HEAD/full GET verification and marker last keep partial uploads out of verified inventory. Production, payment and notification setup remain on hold.
- #316 Guarded count pruning (30 verified backups plus latest drill copy, 35/40-day locks, no lifecycle) preserves recovery in outages. Stale/insufficient inventory or incomplete pagination/analytics freezes deletion. The checker runs independently of the VPS, reports daily alive and shared capacity, and alerts on stale captures, malformed data, overdue drills and implausible sizes. Weekly manual inspection covers notification/platform outages.
- #316 One SQLite DO serializes checker jobs using a persisted run-ID lease, live busy guard and fenced actions/state. VPS needs only local lock. Allow unfinished prefixes six hours from newest upload before alert/freeze. Free tiers only. Activation deferred.
- #316 DO transactions or private atomic fsync/rename persist checker state. Missing/corrupt state freezes pruning. Dedup after delivery, accepting duplicates if persistence is interrupted.
- #316 Directory fsync after archive rename confirms durability. Failed confirmation preserves archives but reports failure. Fixed stage/errors protect secrets. Sweep only owned generated partials under the local lock.
- #316 Group `fukulow-backup` reads deployment `.env` (0640) for Compose `pg_dump`. Docker group is already host-root-equivalent.
- #316 Count unlisted R2 pricing actions as Class A. Dashboard emits them, so failing closed would freeze pruning for the month under `operations-unknown`. The Class A fallback overcounts those actions without treating them as zero.
- #316 Drill R2 restore on the maintainer’s machine so a VPS compromise cannot obtain the read-only restore token/age identity to decrypt backups. VPS must pass full cycle and forced-failure alert. #285 remains blocked. [Activation gate](../spec/deployment.md#operator-runbook-and-production-hold-316)
- #442 Feature work comes first until the chat app is usable. Premature tuning spends time and credit on changing code.
- #442 Once per milestone, run large-scale measurement to find fixable/retestable bottlenecks within cost limits. Heavy runs are slow and costly, and one per milestone still catches regressions. Mac/single runs cannot establish exact capacity. Small CI `make load` remains the per-change regression check. Add `load/` files only when milestone measurement needs them. Unused harness code costs review and maintenance without adding evidence. The cadence batches heavy runs and preserves every acceptance gate, including #431 formal performance evaluation after the first rented-server deploy and #153 search-engine selection.
- #475 Split server tests into three nextest shards because they set PR wall time. Keep the required `server` aggregator. Save Rust caches only from main. Caches readable only by their PR had overflowed the 10 GB limit and evicted main’s.

## Entries in other parts

Entries that also govern this area, listed by the start of the entry in that part.

- [realtime](realtime.md): `#196 B app pool`, `#196 B keeps`, `#196 B headroom is shared`, `#196 B sets session-level`, `#196 B startup parameters`, `#196 B leaves RLS`, `#196 B migrations disable`

- [auth](auth.md): `#197 FUKULOW_COOKIE_SECURE describes the public HTTPS`, `#197 HSTS max-age=31536000 lives at TLS`, `#197 Vite manifest outputs alone get`, `#194: forwarded IPs require a trusted`, `#194: require a nonblank FUKULOW_SETUP_TOKEN in`, `#194: Compose separates proxy/app edge from`
- [auth](auth.md): `#401: app and both proxies send`
- [auth](auth.md): `CI probes health through Caddy HTTPS`, `#163: after an unexpected worker exit`, `#163 manual check: node scripts/check-compose-restart.ts verifies`
- [realtime](realtime.md): `#195: retain provisional 60 s drain`, `#88/#194 B bounds one-shot migration lock`
- [web](web.md): `#211: Compose browser acceptance runs on`, `#211/#254: upload only allowlisted report.json on`
