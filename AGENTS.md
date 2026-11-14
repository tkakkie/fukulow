# fukulow

Business chat app (Zulip-like: channels, topics, reply chains), built mostly by AI. Goals: high concurrency, fast display; product quality.
Source of truth: code, tests, `openapi.json`. Docs (create no others): `docs/spec.md`, `docs/decisions.md` (why), `docs/invariants.md` (invariant -> test), `docs/workflow.md` (follow without a human prompt), `docs/measurements.md` (past measurement records), `docs/ui.md` (web UI rules). An approved split Issue may add `docs/<kind>/<area>.md` parts of these kinds only (`docs/workflow.md` §13). Each doc's header says how to write it.

## What to read
Always this file. Default: search headings/keywords, read only matches; split doc: index, then matching parts (cross-area: every related part). Nothing found: try other keywords (spec terms, modules, error values) and related Issues/PRs before assuming no constraint.

| Task | Read first |
|---|---|
| Behaviour change | `docs/spec.md` index, relevant parts |
| Auth, permissions, tenant scoping, real-time delivery, API contract, migrations | `docs/decisions.md` and `docs/invariants.md` indexes, then the parts for those areas (required) |
| Web UI (components, layout, styles, copy, keyboard) | `docs/ui.md`, in full |
| Performance, load tests, regression checks, comparing results | related `docs/measurements.md` section only; never otherwise |
| Implementing / PRs, reviews, labels, sweeps, conflicts, merges | "Workflow essentials" / matching `docs/workflow.md` section |
| Toolchain, dependencies, languages / writing a doc | `docs/workflow.md` §8 / the doc's header (splits: §13) |

Generated files (`openapi.json`, `web/src/api-schema.d.ts`, lockfiles) and CI/E2E/load logs: grep or read the relevant part first. Reorganising or verifying docs: read in full. "Not whole" is a default, never a ban on a needed diagnosis or consistency check.

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
- Tier 2: Rust, TypeScript, SQL, short bash (`#!/usr/bin/env bash`, `set -euo pipefail`, bash 3.2; over ~20 lines or sharing variables -> TypeScript); others need maintainer approval. Toolchains (Rust, Node) and images: exact versions. Libraries: lockfile-pinned; manifest ranges allowed; changed only by reviewed PRs. Details: `docs/workflow.md` §8.
- Sending a message is idempotent (client-generated id); reconnect uses per-channel sequence numbers.
- No new dependency, abstraction or doc without a reason in the PR.

## Boundaries
- Module direction uses the explicit acyclic edge table in `scripts/module-direction.rs`: `realtime` -> `messages`, `channels`, `auth`; `messages` -> `channels`, `auth`; `channels` -> `auth`. Cross-module references require a listed direct edge; reachability does not grant permission. More crates are allowed with a PR reason (responsibility, dependency direction, build time, testability); crates keep this DAG, no cycles; release stays one binary, one image. Production domain split: #378.
- Target DAG (#319): the four domain modules keep these edges; leaves `database` (used by channels, messages; by auth only once #314 needs it) and `shutdown` (used by messages, realtime) depend on nothing. Both leaves remain outside the checked module list in #318; checking them follows in M1 (#320). Kept on purpose: `docs/decisions/process.md` #319.
- A module owns its tables and exposes functions; others never query them. Handlers live in their module: parse, call, map errors.
- Web layers (target for new code, Tier 2): (1) small components: display, input, a11y, Japanese strings; no I/O, `fetch`, sockets or sync rules. (2) `.svelte.ts` adapter: thin `$state`/`$derived` over the controller.
- (3) controller (plain `.ts`): sockets, timers, backoff, HTTP, effects. (4) pure protocol: `step(state, input) -> {state, effects}`, no clock, randomness, I/O, Svelte; vitest-testable. (5) API/transport: `src/api.ts`, WebSocket client, generated types.
- 4 and 5 do not know each other; only message sync has a protocol, CRUD is controller + adapter; no `$state` in 3 or 4.
- REST/WebSocket types only from generated `api-schema.d.ts` (review); web-only types not duplicating the contract are fine. Behaviour: `docs/spec/realtime.md` "Real-time sync contract".

## Commands
- Server: `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
- Web: `npm --prefix web run check && npm --prefix web test && npm --prefix web run build` (invariants checked statically; cargo matching runs in CI server job)
- Migrations: `bash scripts/check-migrations.sh <base-sha>`, `node --test scripts/check-migrations.test.ts`; the schema guard runs in `cargo test` with Postgres. API types: `make api`. Module direction: `docs/workflow.md` §8.

## Workflow essentials
- Own worktree, branch `claude/|codex/|antigravity/<topic>`. Never push to `main`; only the maintainer merges (or tells an AI to).
- Codex and Antigravity run as workers: they do not commit, push or use GitHub; the orchestrator does those steps for them (`docs/workflow.md` §4).
- Implement only an Issue with "Done when" and `status:ready`; set `status:working`; draft PR; CI green; maintainer always reviews.
- At most one status label, set by the AI handing off: `working` (AI busy), `ai-review` (CI/AI/Copilot), `ready` (may start), `human-review` (maintainer; entry conditions in `docs/workflow.md` §2, §5), `needs-decision` (question in last comment). Also `security`, `bug`, `risk:needs-review` (auth, permissions, real-time, migrations), `blocked`; every Issue has a milestone (a sprint, or `Backlog` if unscheduled).
- GitHub text in English (Japanese only for UI strings). AI comments, reviews, PR bodies end with `AI: <name> / model: <id> / effort: <level>`.
