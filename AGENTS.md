# fukulow

Business chat app (Zulip-like: channels, topics, reply chains), built mostly by AI. Goals: high concurrency, fast display; product quality.
Source of truth: code, tests, `openapi.json`. Docs (create no others): `docs/spec.md`, `docs/decisions.md` (why), `docs/invariants.md` (invariant -> test), `docs/workflow.md` (follow without a human prompt), `docs/measurements.md` (past measurement records), `docs/ui.md` (web UI rules). An approved split Issue may add `docs/<kind>/<area>.md` parts of these kinds only (`docs/workflow.md` §13).

## What to read
- Always this file; for a behaviour change, the relevant `docs/spec.md` sections first.
- Web UI work (components, layout, styles, copy, keyboard): `docs/ui.md` first, in full.
- `docs/decisions.md`, `docs/invariants.md`: by default search headings/keywords and read only the matches.
- Auth, permissions, tenant scoping, real-time delivery, API contract, migrations: check the related decisions and invariants first (required).
- Nothing found: try other keywords (spec terms, modules, error values) and related Issues/PRs before assuming no constraint.
- `docs/measurements.md`: never in normal work or unrelated changes; for performance work, load tests, regression checks or comparing results, search and read only the related section.
- A doc split into an index plus `docs/<kind>/<area>.md` parts: open the index only for related work, then the matching parts; a cross-area change reads every related part.
- Reorganising or verifying docs: read them in full. "Not whole" is a default, never a ban on a needed check.
- `docs/workflow.md` by task: implementing needs only "Workflow essentials"; PRs, reviews, labels, sweeps, conflicts, merges: the matching section.

## Writing docs
- `decisions.md`: only current decisions, what + why in at most 300 characters each; split or link `#n` rather than blur a reason.
- `measurements.md`: only results behind a decision, performance comparisons or key regression checks, with reproduction conditions and limits; no routine/debug logs, raw artifacts or duplicates; never silently rewrite or drop an old record.
- `ui.md`: short shared UI rules (layout, navigation, tokens, components, states, accessibility, keyboard, copy); it wins over mockups.
- `invariants.md`: a Rule cell states what must hold, scope and exceptions included, in at most 160 characters.
- Splitting a doc (over ~40 KB, repeated conflicts, or a major `spec.md` feature) is evaluated, not automatic: only via its own approved Issue, never in an unrelated PR, no new doc kinds. Procedure: `docs/workflow.md` §13.

## Stack
Rust (axum, tokio, sqlx), PostgreSQL, WebSocket in `server/`; Svelte + Vite SPA (no SvelteKit/SSR) in `web/`, embedded (rust-embed). One Docker image; compose profile Caddy (default) or nginx; Xserver VPS.
API `/api/v1`; OpenAPI from Rust (utoipa) -> `openapi.json` -> TS types; Kotlin (KMP) later; real-time events in the same schema. Auth: cookie (web), bearer (native).

## Rules
- Tier 1 (absolute): CI-enforced, or review-enforced where marked. Tier 2 (default): deviate only for a better way, one line in the PR. A CI check is added only if reliable (with a negative test); until then the rule is review-enforced.
- Tier 1, CI (the failing check explains): `make api` output committed; toolchain versions agree; no secrets (public repo); migrations append-only; every invariants row names an existing test.
- Tier 1, CI: every table has `organization_id` NOT NULL except exactly `public.organizations`, `public._sqlx_migrations`, `public.accounts`, `public.account_sessions` (other schemas are not exempt).
- Tier 1, CI: no `unsafe`; no `unwrap()`/`expect()`/`panic!()` outside `#[cfg(test)]`; startup errors are `Result`. A lint exception needs a reason and maintainer approval; no abstraction just for a lint.
- Tier 1, CI: module direction (Boundaries) on resolved paths, macros, calls, fields and inferred types, in production and test targets. `main`/`openapi`/`lib` are composition exceptions; root nominal-wrapper fields and composition-root bodies are not traced (review).
- Tier 1: web reaches the server only via its API layer (CI). No hand-written copy of an API type (review; structural copies type-check).
- Credentials never in web storage. CI forbids all web storage until a UI-settings helper exists; what it may store is review-enforced.
- Tier 1, review: Organization data is always scoped by `organization_id`; documented global operations (e.g. setup existence check) are exceptions; do not force a fake scope onto them.
- Tier 1, review: changing permissions, tenant scoping or real-time delivery needs a denial test per denial the rule defines; cross-Organization alone is not enough (e.g. private Channel non-member).
- Tier 2: `docs/spec.md` terms everywhere, no synonyms; errors as `ErrorBody`; SQL only in the table's owning module; indexes in the migration that needs them; no N+1 on hot paths; small files/functions; comments only for non-obvious reasons.
- Sending a message is idempotent (client-generated id); reconnect uses per-channel sequence numbers.
- No new dependency, abstraction or doc without a reason in the PR.

## Boundaries
- One crate; modules `realtime` -> `messages` -> `channels` -> `auth`, no reverse edges. Split crates only when build time, deps or parallel work hurt.
- A module owns its tables and exposes functions; others never query them. Handlers live in their module: parse, call, map errors.
- Web layers (target for new code, Tier 2): (1) small components: display, input, a11y, Japanese strings; no I/O, `fetch`, sockets or sync rules. (2) `.svelte.ts` adapter: thin `$state`/`$derived` over the controller.
- (3) controller (plain `.ts`): sockets, timers, backoff, HTTP, effects. (4) pure protocol: `step(state, input) -> {state, effects}`, no clock, randomness, I/O, Svelte; vitest-testable. (5) API/transport: `src/api.ts`, WebSocket client, generated types.
- 4 and 5 do not know each other; only message sync has a protocol, CRUD is controller + adapter; no `$state` in 3 or 4.
- REST/WebSocket types only from generated `api-schema.d.ts` (review); web-only types not duplicating the contract are fine. Behaviour: `docs/spec.md` "Real-time sync contract".

## Commands
- Server: `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
- Module direction (pinned toolchain, built web assets; re-verify on each Rust bump): `rustup component add rustc-dev && rustfmt --check --edition 2024 scripts/module-direction.rs && node --test scripts/check-module-direction.test.ts && node scripts/check-module-direction.ts`
- Web: `npm --prefix web run check && npm --prefix web test && npm --prefix web run build` (invariants checked statically; cargo matching runs in CI server job)
- Migrations: `bash scripts/check-migrations.sh <base-sha>`, `node --test scripts/check-migrations.test.ts`; the schema guard runs in `cargo test` with Postgres. API types: `make api`.

## Languages and versions (Tier 2)
- Rust, TypeScript (web, tests, Node scripts), SQL, short bash; others need maintainer approval and a decisions line. Tool configs may use native formats; shared settings in `.env.example`/Makefile.
- bash: `#!/usr/bin/env bash`, `set -euo pipefail`, bash 3.2 (no associative arrays); over ~20 lines or sharing variables -> TypeScript.
- Exact patch versions, bumped deliberately. Rust: `rust-toolchain.toml`; Node: `.node-version` = `web/package.json` `engines`; Dockerfile and CI follow. Dependabot weekly; `cargo deny`, `npm audit` in CI.

## Workflow essentials
- Own worktree, branch `claude/|codex/|antigravity/<topic>`. Never push to `main`; only the maintainer merges (or tells an AI to).
- Implement only an Issue with "Done when" and `status:ready`; set `status:working`; draft PR; CI green; maintainer always reviews.
- At most one status label, set by the AI handing off: `working` (AI busy), `ai-review` (CI/AI/Copilot), `ready` (may start), `human-review` (maintainer; entry conditions in `docs/workflow.md` §2, §5), `needs-decision` (question in last comment). Also `security`, `bug`, `risk:needs-review` (auth, permissions, real-time, migrations), `blocked`; every Issue has a milestone (a sprint, or `Backlog` if unscheduled).
- GitHub text in English (Japanese only for UI strings). AI comments, reviews, PR bodies end with `AI: <name> / model: <id> / effort: <level>`.
