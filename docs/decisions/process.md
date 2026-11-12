# Decisions: process

Product, stack, delivery, project rules, CI and AI process. Writing rules and the other parts: [index](../decisions.md).

## Product, stack and delivery
- #198 A: readiness acquire/query each get 200 ms, allowing brief local DB jitter but failing fast on outages. Single flight caps shared FIFO-pool use at one slot without send/watermark permits; a query timeout detaches the socket to release its slot immediately.
- #198 A: use the existing server binary's one-second HTTP probe command: the final image has no HTTP client. It reaches the configured app port via loopback for wildcard binds, avoiding a dependency or published port; unhealthy alone never triggers Compose restart.
- Rust + PostgreSQL + WebSocket; Svelte SPA embedded in the binary. Reason: performance, one-image delivery.
- Reverse proxy is optional: the app speaks plain HTTP; Caddy (default) or nginx via compose profile. Reason: Caddy gave trouble in ribbitto and may limit performance.
- #194 C: use UID/GID 10001 and root-owned runtime files; the app needs only network/DB access. Pin external images by tag + multi-platform digest for reproducibility; weekly Docker/Compose Dependabot updates retain reviewed upgrades. Bound local logs to 10m x 3 per container.
- #194 C: no init wrapper or STOPSIGNAL override: the server spawns no child processes to reap, and #195 registers SIGTERM/SIGINT before serving and drains work. Exec-form CMD keeps the binary as PID 1; SIGTERM is already Docker's default.
- OpenAPI generated from Rust, committed, diff-checked in CI. Reason: future native clients (Kotlin).
- `organization_id` on every table from day one. Reason: multi-organization later without retrofit.
- Public repo. Reason: free CI minutes.
- #194 B: one-shot `migrate` holds owner credentials; app waits for success and only validates migration versions/checksums/state. Owner credentials stay out of app. PostgreSQL 18 persists under `/var/lib/postgresql`.
- Deployment is single-process: live delivery, revocation, throttles and admission are process-local. Multiple server processes need shared publication/revocation and a shared limiter first (#18, #57).
- #195: shutdown also returns 503 for non-API paths, including static assets and SPA routes; these middleware rejections are outside OpenAPI.
- #194 B: migration advisory/DDL lock waits fail after 5 s (#88, #93). The one-shot service does not restart automatically; operators resolve the blocker and rerun, keeping app stopped on failure.
- PostgreSQL 17+ is required (`transaction_timeout`); on older servers every send/subscription fails loudly. Compose and CI use 18; no startup check (#158).
- Dependabot security updates were enabled on 2026-11-08 but no security PR has been seen, so do not claim they work. VPS automatic OS security updates are planned with the deploy work.
- #194 B: shared initdb/explicit roles SQL keeps `fukulow` owner and updates `fukulow_app` without changing rows. Bind/quote passwords after transaction-local log/nested-stat suppression; fail closed without settings rights. Reject ownership/memberships rather than reassigning them.
- #194 B: grant DML/sequence USAGE by default for future owner-created objects; normalize migration history to SELECT after migrating. Revoke public CREATE/TEMP so indirect privileges cannot bypass trigger protection. Reapply grants after #198 no-ACL restore.

## Rules, CI and AI process
- Rules have tiers: Absolute (CI only with a reliable check), Default (deviation needs a PR line), Free. Reason: hard rules without a good check push AIs into awkward code; boundaries and tenant isolation are worth enforcing (#29).
- One crate with module boundaries, each module owning its tables. Reason: cross-crate refactors are costly for AI-driven work; revisit when build time, dependencies or conflicts hurt.
- #194 B: `database` is composition-level deployment/startup plumbing, outside the four domain modules traced by module direction; review enforces that it never depends on them.
- #248: shared read-only closures ROLLBACK on Ok/Err and reuse clean backends. A Drop guard discards cancellation and failed BEGIN/ROLLBACK; SQLx 0.8.6 records depth only after BEGIN responds, so its rollback-on-drop misses cancelled starts.
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
- #260 AI models (credit cost): Codex sol and Antigravity Argon at medium; high only on H1-H6 or security. Astra reviews: high only for round 1 of risk:needs-review. Carbon dropped: no clear gain on #138 vs Argon on #222.
- #275 Copilot findings outside the PR's changes become new Issues and do not block it, except security, data loss or corruption, cross-Organization leaks, serious defects caused by the PR, or an unmet Done when. Reason: on #273 each re-review surfaced one pre-existing gap and cost a fix/CI cycle.
- #275 Copilot is requested once per PR; another request only within the 2 AI review rounds and only when clearly needed; changing the reviewing AI does not reset the cap. Reason: credit cost; repeated Copilot reviews mostly found out-of-scope issues.
- #275 The #260 Argon browser-check review trial ended: it found no defect the required review missed, so its cost-effectiveness is unproven. Argon stays the UI implementer.
- #275 Issue-level AI review is required only for risk:needs-review. AI-decidable Issues (minor bug fixes, tests, docs) still go straight to status:ready; Issues needing maintainer approval go to status:human-review. Reason: credit cost.
- #275 Until DM, Mention and Search are merged, new process improvements and doc rules are paused, except security, serious defects, MVP blockers or explicit maintainer requests. Reason: spend credit on MVP features.
- k6 bumps are manual (Dependabot does not see `K6_IMAGE` in Makefile): keep the exact tag, type-check and smoke-test each bump; `@types/k6` versions need not match runtime; digest pinning deferred (#20).
- #295 A: top-level modules may form an explicit DAG instead of a total order, fixed only after checking real dependencies, table ownership and authorization boundaries. The checker keeps every current capability and adds allowed, denied and cycle fixtures.
- #295 The checker change and each module move are separate small PRs that change no API, OpenAPI, WebSocket, authorization, DB access or Unread behaviour. DM #151 needs no move first (checked 2026-11-12), so moves wait for a later Sprint.
- #296 B: RPO is a 24 h target, not a guarantee, from the data capture time of the newest verified off-VPS backup (not copy/verify time). Backup, off-VPS copy and hash check to be automated (#316; manual until then), alerting on failure or capture 24 h old or older; retention, secrets, drill stay.
- #296 WAL archiving and PITR are future requirements: the first deploy (#285) is dogfooding. Any new external service or paid storage needs maintainer approval of its setup and cost before implementation.
- #297 A: toolchains (rust-toolchain.toml, .node-version/engines) and images stay exact; libraries are pinned by committed lockfiles, manifests may use ranges (not Playwright, exact for its image), and resolved versions change only in reviewed PRs. Reason: lockfiles give reproducibility without churn.

## Entries in other parts

Entries that also govern this area, listed by the start of the entry in that part.

- [auth](auth.md): `#197 FUKULOW_COOKIE_SECURE describes the public HTTPS`, `#197 HSTS max-age=31536000 lives at TLS`, `#197 Vite manifest outputs alone get`, `#194: forwarded IPs require a trusted`, `#194: require a nonblank FUKULOW_SETUP_TOKEN in`, `#194: Compose separates proxy/app edge from`
- [auth](auth.md): `CI probes health through Caddy HTTPS`, `#163: after an unexpected worker exit`, `#163 manual check: node scripts/check-compose-restart.ts verifies`
- [realtime](realtime.md): `#195: retain provisional 60 s drain`, `#88/#194 B bounds one-shot migration lock`
- [web](web.md): `#211: Compose browser acceptance runs on`, `#211/#254: upload only allowlisted report.json on`
