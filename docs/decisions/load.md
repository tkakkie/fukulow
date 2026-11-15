# Decisions: load

Load testing and measurement rules. Writing rules and the other parts: [index](../decisions.md).

## Load testing and measurement
- #20 load scaffold: `npm --prefix load ci && npm --prefix load run check && npm --prefix load test`; `make load` signs in to a disposable test Organization (`LOAD_EMAIL`, `LOAD_PASSWORD`; `LOAD_BOOTSTRAP=1` only for an empty DB). CI runs 5 sockets for 10 s.
- #57 PR A: a fixed offered rate replaces response-paced sends: `PUBLISHERS` sends every `PUBLISH_INTERVAL_MS`; a missed deadline fails the run instead of reducing or bursting traffic. Missing deliveries, gaps and unexpected closes fail; no reconnect masking.
- Compare before/after only with `make load-record` (isolated Compose project, dedicated PostgreSQL with pg_stat_statements, own cleanup, never the shared test DB), e.g. `CHANNELS=1 SUBSCRIBERS=20 PUBLISHERS=2 PUBLISH_INTERVAL_MS=100 DURATION_SECONDS=30` (#57).
- Report SQL per offered send as top-level queries, all statements and statements incl. nested FK checks; pg_stat_database is supporting evidence only. Keep raw artifacts outside Git; reuse identical conditions for comparisons (#57).
- #178 before/after: 6 -> 8 top-level queries per send is #146 Membership/revision authorization, not a hardening regression. The 10,000-socket HTTP p95 drop spans #134-#173 and #146, so it is not attributable to one change.
- #178 harness: `make load-record` with `LOAD_DIRECT_NETWORK=1` (port-forwarding failed at 9,990 sockets), `LOAD_SERVER_SOURCE` for the worktree, `LOAD_LEGACY=1` only for pre-#146 builds; short windows are rejected. Never attach the raw artifact directory publicly (server logs, source patch).
- Measurements so far are modest single-host runs: none establishes the 10k-connection target, a capacity or a latency guarantee. Heavy run: `CHANNELS=1 SUBSCRIBERS=10000 ... make load` with `nofile` 65536; one generator loop can saturate (#20).

- #151 adopts DM performance acceptance (2026-11-14): 10,000 connections, 2,000 sends/s and spec/dms.md latency/DB/memory budgets. Reason: validate combined O5/write load; include hot bursts, notice loss, bootstrap, bounded backlog/drain and storage/WAL/lock/backup/restore cost.

- #151: keep main at exactly 100 DMs/Member; measure held200 separately under full mixed load. Samples sum over ten Organizations; judge each Organization too. Reason: preserve fixture comparability and prevent aggregate tails from hiding an Organization failure.
- #151 (2026-11-15): each mixed-load Organization needs ≥1,000 samples/class/attempt; first-page/deep browsing is judged only on a separate browsing Organization at full load. Reason: per-Organization tails stay visible, and the 100-DM fixture cannot supply deep continuations.

- #151 absolute budgets are judged on hourly-rented Linux servers after the first deploy (#431); the developer Mac is only for same-machine comparisons (#426, #153, #196). Reason: on a Mac the generator shares the CPU and a VM is added (2026-11-15).

## Entries in other parts

Entries that also govern this area, listed by the start of the entry in that part.

- [process](process.md): `#401: deployment/load app and migrate use`
- [process](process.md): `k6 bumps are manual (Dependabot does`
- [realtime](realtime.md): `#212 follows up handshake admission, listen`, `#151 DM list base limits`, `#151 B4 adopts`, `#151 coalesces discovery`
