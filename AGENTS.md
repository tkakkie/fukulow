# fukulow

Business chat app (Zulip-like: channels, topics, reply chains). Hobby project, built mostly by AI.
Goals: high concurrency (connections, writes), fast display. Product quality, not a toy.

Read `docs/spec.md` before changing behaviour. Add decisions to `docs/decisions.md` (a few lines each).
Do not create other docs. Code, tests and `openapi.json` are the source of truth.

## Stack
- Backend: Rust (axum, tokio, sqlx), PostgreSQL, WebSocket for real-time. Dir: `server/`
- Frontend: Svelte + Vite SPA (no SvelteKit/SSR), embedded into the Rust binary (rust-embed). Dir: `web/`
- Delivery: one Docker image. Compose profiles for a reverse proxy: Caddy (default) or nginx. Target: Xserver VPS.
- API: `/api/v1`, OpenAPI generated from Rust (utoipa) into `openapi.json` (committed; planned, lands with the auth slice). TS types are generated from it;
  Kotlin (KMP) clients later. Real-time event types are in the same schema.
- Auth: session cookie (web) and bearer token (native apps).

## Rules
Three tiers: **Absolute** (Tier 1) is meant to be enforced by CI; **Default** (Tier 2) is followed unless there is a better way, and a deviation needs one line in the PR saying why; everything else is free.
A Tier 1 rule only gets a CI check that is reliable (with a negative test); without one it is Tier 2 or a review item. Until a check lands, a Tier 1 rule is approved but enforced by review only.

Tier 1, enforced by CI today:
- `openapi.json` and the generated TS types are regenerated and diff-checked (`make api`); toolchain versions agree (see Versions).
- No secrets in the repo (gitleaks on PR and main, plus `.gitignore` and review). The repo is public.
- Every table has `organization_id` (NOT NULL), except the `organizations` root and migration bookkeeping; migrations are append-only: an existing migration file is never edited or deleted (#31, #40).
- Rust: `unsafe` forbidden; `unwrap()`, `expect()` and `panic!()` denied outside `#[cfg(test)]` (clippy lints, with negative compilation tests). Startup errors propagate as `Result`. An unavoidable exception needs a stated reason and the maintainer's approval; do not add abstractions just to satisfy the lint (#32, #41).
- Module dependency direction (see Boundaries) is checked using rustc name resolution for production and test targets, including aliases, re-exports and macros, with negative compilation tests; `main`, `openapi` and `lib` are composition exceptions (#46).

Tier 1, approved, CI check pending (review enforces until the Issue lands):
- Every row of `docs/invariants.md` names a test that exists (checked against real test definitions, not text search) (#34).
- The web reaches the server only through its API layer (REST and WebSocket), using the types generated from `openapi.json` as the source of truth (no hand-written copies of API types); credentials are never kept in web storage (harmless UI settings may be) (#34).

Tier 1, review-enforced (tests run in CI; review judges whether they are the right ones):
- Data that belongs to an Organization is accessed scoped by `organization_id`. Explicitly documented global operations (e.g. the setup existence check, see `docs/decisions.md`) are exceptions; do not force an artificial Organization scope onto genuinely global operations.
- A change to permissions, tenant scoping or real-time delivery needs denial tests for the authorization rule it touches: another Organization is always denied, and so is any other denial the rule defines (e.g. a non-member of a private Channel inside the same Organization). Cross-Organization denial alone is not enough (see `docs/invariants.md`).

Tier 2 (defaults): terms from `docs/spec.md` everywhere (UI, API, DB, code), no synonyms; languages (see Languages); errors as `ErrorBody`; SQL only in the module that owns the table; indexes added with the migration that needs them; no N+1 on hot paths; small files and functions; comments only for non-obvious reasons; Svelte: small components, state in plain TS modules with vitest tests.

Also: sending a message is idempotent (client-generated id); reconnect uses per-channel sequence numbers. Keep it simple: no new dependency, abstraction or doc without a reason in the PR.

## Boundaries
- One Rust crate, split by module: `auth`, `channels`, `messages`, `realtime`. Dependency direction (may use): `realtime` -> `messages` -> `channels` -> `auth`; no reverse edges.
- Each module owns its tables and exposes functions; other modules do not query its tables directly. HTTP handlers live in their module: parse input, call module functions, map errors.
- Web: API layer (`src/api.ts`, plus the WebSocket client) -> plain TS state modules -> Svelte components; components never call `fetch` or open sockets. Message and event types come from the generated `api-schema.d.ts`, not local copies.
- Split into crates only when build time, dependencies or parallel-work conflicts hurt; no premature design.

## Commands (fill in as they appear)
- Server: `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
- Module direction: `rustup component add rustc-dev && rustfmt --check --edition 2024 scripts/module-direction.rs && node --test scripts/check-module-direction.test.ts && node scripts/check-module-direction.ts` (pinned Rust toolchain; build web assets first).
- Web: `npm --prefix web run check && npm --prefix web test && npm --prefix web run build`
- Migrations: `bash scripts/check-migrations.sh <base-sha>`; guard tests: `node --test scripts/check-migrations.test.ts`. Schema guard runs in `cargo test` with Postgres.
- API types: `make api` (regenerates openapi.json and TS types). CI fails on a diff.

## Workflow
- Work in your own worktree and branch: `claude/<topic>`, `codex/<topic>`, `antigravity/<topic>`. Never push to `main`.
- Issue with a "Done when" and label `status:ready` before implementing. Open a draft PR; CI must pass.
- Issue review. Needs the maintainer (below): first an AI that did not write the Issue reviews it (`status:ai-review`), then it goes
  to `status:human-review`; "OK" comment = approved, then the AI sets `status:ready`. The AI review is required for `risk:needs-review`
  and large Issues, optional for small ones: the author may skip it, goes straight to `status:human-review`, and records the decision and reason in the Issue.
  Max 2 rounds; if blocking findings are still unresolved, `status:needs-decision` with the question. Needs the maintainer:
  always for any new feature or behaviour change (a misread spec means rework), and for auth/permissions/real-time/migrations,
  API or schema contract changes, new dependencies or languages, cost, deploy, secrets. Feature Issues start with
  "How I read the spec" (3-5 lines, spec terms) before "Done when".
  AI decides alone only when none of the above applies: bug fixes with a clear repro, refactors without behaviour change,
  tests, CI, docs, patch updates. Being described in `docs/spec.md` does not exempt a feature: the maintainer still approves
  the Issue (the spec says what, the Issue says how it will be read and built). PRs always get the maintainer's review.
- Implementer by area: Codex = Rust server, DB, auth/permissions, real-time, concurrency, load tests.
  Claude = design, OpenAPI, docs, review. Antigravity = Svelte (screens and state modules), browser checks, E2E.
- PRs touching auth, permissions, real-time or migrations are reviewed by an AI that did not write them.
- Only the maintainer merges (or explicitly tells an AI to).

## Languages (keep it small; Tier 2 default)
- Allowed: Rust (server, server tests), TypeScript (web, vitest, Playwright, small scripts run with Node), SQL, short bash.
- No Python, Go or other languages. Adding one needs the maintainer's approval and a line in `docs/decisions.md`.
- Config files may use the tool's native format (e.g. `svelte.config.js`). Everything we write is TypeScript.
- bash: macOS ships 3.2; write scripts that work on 3.2 (`#!/usr/bin/env bash`, `set -euo pipefail`, no associative arrays).
  Scripts over ~20 lines or sharing variables become TypeScript. Shared settings live in `.env.example` / Makefile variables.

## Versions and updates
- Policy: pin the exact patch version everywhere, and move it deliberately (Dependabot PRs or a manual bump), never implicitly.
  Single sources: Rust = `rust-toolchain.toml`; Node = `.node-version` (and `web/package.json` `engines`, kept equal).
  The Dockerfile tags (`rust:<ver>-slim`, `node:<ver>-slim`) and CI (`rustup` / `node-version-file`) follow those files.
  CI fails if the Dockerfile or `engines` disagree with them.
- Version updates: `.github/dependabot.yml` (weekly, grouped) covers Cargo, npm, GitHub Actions, Docker.
  Security updates are a separate GitHub setting (Settings > Advanced Security: Dependabot alerts, Dependabot security updates);
  enabled by the maintainer on 2026-11-08 (verified via API). No security PR has been seen yet, so do not claim it is proven.
- `cargo deny` and `npm audit` run in CI (PR, main, nightly).
- Update PRs: an AI checks the changelog for breaking changes, then asks the maintainer to merge.
- Production VPS: automatic OS security updates (planned with the deploy work).

## Who is on the move (labels)
Every open issue/PR carries at most one status label, set by the AI that hands off:
- `status:working` - an AI is working; do not review yet.
- `status:ai-review` - waiting for CI / AI review / Copilot.
- `status:human-review` - maintainer's turn: an Issue to approve, or a PR with CI green, required AI reviews done (including Copilot, when requested: wait until its review has finished) and marked ready.
  Filter: `label:status:human-review`. After approval an Issue becomes `status:ready`; a PR is merged, or goes back to `status:working` if changes are requested.
- `status:ready` - Issue approved by the maintainer; an AI may start (then `status:working`).
- `status:needs-decision` - maintainer's turn: a decision is needed; the question is in the last comment.
- Decide-free work continues without asking; only decisions go to the maintainer. Nothing stays green and unlabelled: when CI and reviews are done, the label moves to `status:human-review`.

## Planning and labels
- Milestone = one-week sprint (keep at most 2 open). Modules are expressed with labels, not milestones.
- Labels are only the status labels above plus: `security` (red) and `bug` (orange) so urgent items stand out
  (urgent = `security`/`bug` + `status:human-review`/`status:needs-decision`); `risk:needs-review` (auth, permissions,
  real-time, migrations); `blocked`. No area/type/ai labels: files, commits and the AI signature line say that. Every issue gets a milestone.
- Server code is split by module inside one crate (`auth`, `channels`, `messages`, `realtime`, ...); the OpenAPI contract
  lets web work proceed without waiting for the server.

## Reviews
- Review cap: AI review of an Issue or PR is at most 2 rounds in total, counted per Issue/PR; changing the reviewing AI does not reset it.
  Round 2 checks only the changes and how earlier findings were addressed. Non-blocking findings become
  follow-up Issues, not another round. Blocking findings unresolved after round 2 -> `status:needs-decision`.
- Copilot auto-review is OFF (it burns credits). Request it once per PR, by hand, when CI is green and the work is
  done: `gh pr edit <n> --add-reviewer @copilot`. Only for `risk:needs-review` or large code PRs. Re-request only if the maintainer asks.
- Write everything on GitHub (Issues, PRs, comments, reviews, commits) in English; Japanese only where unavoidable (e.g. UI strings).
- Every issue comment, review and PR body from an AI ends with one line: `AI: <name> / model: <id> / effort: <level>`.
