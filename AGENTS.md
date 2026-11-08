# fukulow

Business chat app (Zulip-like: channels, topics, reply chains). Hobby project, built mostly by AI.
Goals: high concurrency (connections, writes), fast display. Product quality, not a toy.

Read `docs/spec.md` before changing behaviour. Add decisions to `docs/decisions.md` (a few lines each).
Do not create other docs. Code, tests and `openapi.json` are the source of truth.

## Stack
- Backend: Rust (axum, tokio, sqlx), PostgreSQL, WebSocket for real-time. Dir: `server/`
- Frontend: Svelte + Vite SPA (no SvelteKit/SSR), embedded into the Rust binary (rust-embed). Dir: `web/`
- Delivery: one Docker image. Compose profiles for a reverse proxy: Caddy (default) or nginx. Target: Xserver VPS.
- API: `/api/v1`, OpenAPI generated from Rust (utoipa) into `openapi.json` (committed). TS types are generated from it;
  Kotlin (KMP) clients later. Real-time event types are in the same schema.
- Auth: session cookie (web) and bearer token (native apps).

## Rules
- Use the terms in `docs/spec.md` everywhere (UI, API, DB, code). Do not invent synonyms.
- Every table has `organization_id`; every query is scoped by it (multi-organization later, never retrofit).
- A change to permissions, tenant scoping or real-time delivery needs a denial test (see `docs/invariants.md`).
- Sending a message is idempotent (client-generated id). Reconnect uses per-channel sequence numbers.
- Never commit secrets. The repo is public.
- Keep it simple: no new dependency, abstraction or doc without a reason in the PR.

## Commands (fill in as they appear)
- Server: `cargo fmt --check && cargo clippy -- -D warnings && cargo test`
- Web: `npm --prefix web run check && npm --prefix web test && npm --prefix web run build`
- API types: `make api` (regenerates openapi.json and TS types; CI fails on diff)

## Workflow
- Work in your own worktree and branch: `claude/<topic>`, `codex/<topic>`, `antigravity/<topic>`. Never push to `main`.
- Issue with a "Done when" and label `ready` before implementing. Open a draft PR; CI must pass.
- Implementer by area: Codex = Rust server, DB, auth/permissions, real-time, concurrency, load tests.
  Claude = design, OpenAPI, Svelte logic, docs. Antigravity = browser checks, UI, smoke E2E.
- PRs touching auth, permissions, real-time or migrations are reviewed by an AI that did not write them.
- Only the maintainer merges (or explicitly tells an AI to).
