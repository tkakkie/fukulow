# fukulow

Business chat app (Zulip-like: channels, topics, reply chains). Hobby project, built mostly by AI.
Goals: high concurrency (connections, writes), fast display. Product quality, not a toy.
Read `docs/spec.md` before changing behaviour. Code, tests and `openapi.json` are the source of truth.
Docs: `docs/invariants.md` (invariant -> test), `docs/decisions.md` (decisions, a few lines each), `docs/workflow.md` (Issues, PRs, reviews, AI roles, merges; follow it without a human prompt).
Do not create docs other than `docs/spec.md`, `docs/decisions.md`, `docs/invariants.md`, `docs/workflow.md`.

## Stack
- Backend: Rust (axum, tokio, sqlx), PostgreSQL, WebSocket for real-time. Dir: `server/`
- Frontend: Svelte + Vite SPA (no SvelteKit/SSR), embedded into the Rust binary (rust-embed). Dir: `web/`
- Delivery: one Docker image. Compose profiles for a reverse proxy: Caddy (default) or nginx. Target: Xserver VPS.
- API: `/api/v1`; OpenAPI generated from Rust (utoipa) into `openapi.json`; TS types generated from it; Kotlin (KMP) clients later.
- Real-time event types are in the same schema. Auth: session cookie (web) and bearer token (native apps).

## Rules
- Tier 1 (absolute) is enforced by CI; Tier 2 (default) is followed unless there is a better way, and a deviation needs one line in the PR.
- A Tier 1 rule gets a CI check only if it is reliable (with a negative test); until then it is approved but review-enforced.
- Tier 1, CI: `openapi.json` and generated TS types are regenerated and diff-checked (`make api`); toolchain versions agree.
- Tier 1, CI: no secrets in the repo (gitleaks, `.gitignore`, review). The repo is public.
- Tier 1, CI: every table has `organization_id` NOT NULL, except `organizations` and migration bookkeeping.
- Tier 1, CI: migrations are append-only; an existing migration file is never edited or deleted.
- Tier 1, CI: Rust `unsafe` is forbidden; `unwrap()`, `expect()`, `panic!()` are denied outside `#[cfg(test)]`; startup errors propagate as `Result`.
- An unavoidable Rust lint exception needs a stated reason and the maintainer's approval; no abstractions just to satisfy a lint.
- Tier 1, CI: module dependency direction (see Boundaries) is checked on resolved paths, macros, calls, field accesses and inferred types, in production and test targets.
- `main`, `openapi` and `lib` are composition exceptions; root nominal-wrapper fields and composition-root bodies are not traced (review-enforced).
- Tier 1, approved, CI pending (review-enforced): every row of `docs/invariants.md` names a test that exists.
- Tier 1, approved, CI pending (review-enforced): the web reaches the server only through its API layer, with types generated from `openapi.json` (no hand-written copies).
- Credentials are never kept in web storage (harmless UI settings may be).
- Tier 1, review-enforced: Organization data is accessed scoped by `organization_id`; documented global operations (e.g. setup existence check) are exceptions.
- Do not force an artificial Organization scope onto genuinely global operations.
- Tier 1, review-enforced: a change to permissions, tenant scoping or real-time delivery needs denial tests for each denial the rule defines (see `docs/invariants.md`).
- Cross-Organization denial alone is not enough (e.g. also a non-member of a private Channel).
- Tier 2: terms from `docs/spec.md` everywhere (UI, API, DB, code), no synonyms; errors as `ErrorBody`; SQL only in the module that owns the table.
- Tier 2: indexes added with the migration that needs them; no N+1 on hot paths; small files and functions; comments only for non-obvious reasons.
- Tier 2, Svelte: small components; reactive state in a `.svelte.ts` adapter or the component; controller and pure protocol in plain `.ts`.
- The protocol depends on no Svelte, I/O, clock or randomness, so sync logic is vitest-testable. Target structure for new code, not an immediate rewrite.
- Sending a message is idempotent (client-generated id). Reconnect uses per-channel sequence numbers.
- Keep it simple: no new dependency, abstraction or doc without a reason in the PR.

## Boundaries
- One Rust crate, split by module: `auth`, `channels`, `messages`, `realtime`. May use: `realtime` -> `messages` -> `channels` -> `auth`; no reverse edges.
- Each module owns its tables and exposes functions; others do not query its tables. HTTP handlers live in their module: parse input, call functions, map errors.
- Web layers (target; today only some exist): (1) Svelte components: display, input, a11y, Japanese strings; no I/O, no sync rules.
- (2) Svelte state adapter (`.svelte.ts`, thin: maps controller state to `$state`/`$derived`). (3) Controller (plain `.ts`: sockets, timers, backoff, HTTP, runs effects).
- (4) Pure protocol (plain `.ts`: `step(state, input) -> {state, effects}`; no clock, randomness, I/O or `svelte`). (5) API/transport (`src/api.ts`, WebSocket client, generated types).
- Layers 4 and 5 do not know each other. Only message sync has a protocol layer; simple CRUD is controller + adapter.
- Components never call `fetch` or open sockets. `$state` is for the adapter and local component state, not the controller or protocol (Tier 2 for new code).
- Message and event types come from generated `api-schema.d.ts`, not local copies. Behaviour contract: `docs/spec.md` "Real-time sync contract".
- Split into crates only when build time, dependencies or parallel-work conflicts hurt.

## Commands
- Server: `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
- Module direction: `rustup component add rustc-dev && rustfmt --check --edition 2024 scripts/module-direction.rs && node --test scripts/check-module-direction.test.ts && node scripts/check-module-direction.ts`
- Module direction needs the pinned Rust toolchain and built web assets; every Rust toolchain bump must re-verify it (rustc_private is unstable).
- Web: `npm --prefix web run check && npm --prefix web test && npm --prefix web run build`
- Migrations: `bash scripts/check-migrations.sh <base-sha>`; guard tests: `node --test scripts/check-migrations.test.ts`. The schema guard runs in `cargo test` with Postgres.
- API types: `make api` (regenerates `openapi.json` and TS types). CI fails on a diff.

## Languages (Tier 2 default)
- Allowed: Rust (server, server tests), TypeScript (web, vitest, Playwright, small scripts run with Node), SQL, short bash. No Python, Go or other languages.
- Adding a language needs the maintainer's approval and a line in `docs/decisions.md`.
- Config files may use the tool's native format (e.g. `svelte.config.js`). Everything we write is TypeScript. Shared settings live in `.env.example` / Makefile variables.
- bash: macOS ships 3.2; use `#!/usr/bin/env bash`, `set -euo pipefail`, no associative arrays. Scripts over ~20 lines or sharing variables become TypeScript.

## Versions
- Pin the exact patch version everywhere; move it deliberately (Dependabot PR or manual bump), never implicitly.
- Single sources: Rust = `rust-toolchain.toml`; Node = `.node-version` (and `web/package.json` `engines`, kept equal).
- Dockerfile tags (`rust:<ver>-slim`, `node:<ver>-slim`) and CI follow those files; CI fails on disagreement.
- Dependabot (`.github/dependabot.yml`, weekly, grouped) covers Cargo, npm, GitHub Actions, Docker. `cargo deny` and `npm audit` run in CI.

## Workflow essentials (details: `docs/workflow.md`)
- Work in your own worktree and branch `claude/<topic>`, `codex/<topic>` or `antigravity/<topic>`. Never push to `main`. Only the maintainer merges (or explicitly tells an AI to).
- Implement only an Issue with a "Done when" and label `status:ready`. Open a draft PR; CI must pass; PRs always get the maintainer's review.
- Every Issue/PR carries at most one status label, set by the AI that hands off:
- `status:working`: an AI is working. `status:ai-review`: waiting for CI / AI review / Copilot. `status:ready`: Issue approved; an AI may start.
- `status:human-review`: maintainer's turn (Issue to approve, or PR with CI green, required AI reviews done, marked ready). `status:needs-decision`: question is in the last comment.
- Other labels: `security`, `bug`, `risk:needs-review` (auth, permissions, real-time, migrations), `blocked`. Every Issue gets a milestone.
- Write everything on GitHub (Issues, PRs, comments, reviews, commits) in English; Japanese only where unavoidable (UI strings).
- Every Issue comment, review and PR body from an AI ends with one line: `AI: <name> / model: <id> / effort: <level>`.
