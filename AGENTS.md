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
- Use the terms in `docs/spec.md` everywhere (UI, API, DB, code). Do not invent synonyms.
- Every table has `organization_id`; every query is scoped by it (multi-organization later, never retrofit).
- A change to permissions, tenant scoping or real-time delivery needs a denial test (see `docs/invariants.md`).
- Sending a message is idempotent (client-generated id). Reconnect uses per-channel sequence numbers.
- Never commit secrets. The repo is public.
- Keep it simple: no new dependency, abstraction or doc without a reason in the PR.

## Commands (fill in as they appear)
- Server: `cargo fmt --check && cargo clippy -- -D warnings && cargo test`
- Web: `npm --prefix web run check && npm --prefix web test && npm --prefix web run build`
- API types: `make api` (regenerates openapi.json and TS types). Planned: arrives with the auth slice PR (#4); CI will then fail on a diff.

## Workflow
- Work in your own worktree and branch: `claude/<topic>`, `codex/<topic>`, `antigravity/<topic>`. Never push to `main`.
- Issue with a "Done when" and label `ready` before implementing. Open a draft PR; CI must pass.
- Implementer by area: Codex = Rust server, DB, auth/permissions, real-time, concurrency, load tests.
  Claude = design, OpenAPI, Svelte logic, docs. Antigravity = browser checks, UI, smoke E2E.
- PRs touching auth, permissions, real-time or migrations are reviewed by an AI that did not write them.
- Only the maintainer merges (or explicitly tells an AI to).

## Languages (keep it small)
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
- Planned, not in CI yet: `cargo deny` and `npm audit` (vulnerability checks, also on a nightly schedule).
- Update PRs: an AI checks the changelog for breaking changes, then asks the maintainer to merge.
- Production VPS: automatic OS security updates (planned with the deploy work).

## Who is on the move (labels)
Every open issue/PR carries at most one status label, set by the AI that hands off:
- `status:working` - an AI is working; do not review yet.
- `status:ai-review` - waiting for CI / AI review / Copilot.
- `status:human-review` - maintainer's turn: CI green, required AI reviews done, PR marked ready. Filter: `label:status:human-review`.
- `status:needs-decision` - maintainer's turn: a decision is needed; the question is in the last comment.
- Decide-free work continues without asking; only decisions go to the maintainer. Nothing stays green and unlabelled: when CI and reviews are done, the label moves to `status:human-review`.

## Planning and labels
- Milestone = one-week sprint (keep at most 2 open). Modules are expressed with labels, not milestones.
- Labels: `ready`, `blocked`; `area:server|web|api|infra`; `type:feature|bug|chore`; `ai:codex|claude|antigravity`;
  `risk:needs-review` (auth, permissions, real-time, migrations). Every issue gets area, type, milestone.
- Server code is split by module inside one crate (`auth`, `channels`, `messages`, `realtime`, ...); the OpenAPI contract
  lets web work proceed without waiting for the server.

## Reviews
- Copilot auto-review is OFF (it burns credits). Request it once per PR, by hand, when CI is green and the work is
  done: `gh pr edit <n> --add-reviewer @copilot`. Only for `risk:needs-review` or large code PRs. Re-request only if the maintainer asks.
- Every issue comment, review and PR body from an AI ends with one line: `AI: <name> / model: <id> / effort: <level>`.
