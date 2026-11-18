# Decisions: load

Load testing and measurement rules. [Index and writing rules](../decisions.md)

## Load testing and measurement
- #20 `make load` uses a disposable Organization with `LOAD_EMAIL`/`LOAD_PASSWORD`. `LOAD_BOOTSTRAP=1` requires an empty DB. CI smoke is five sockets for 10 s. For a 10k run use `CHANNELS=1 SUBSCRIBERS=10000` and set `nofile` to 65536. One generator loop can saturate. Modest single-host runs establish neither the 10k target nor capacity/latency guarantees.
- #57 Offer a fixed rate (`PUBLISHERS` every `PUBLISH_INTERVAL_MS`), independent of response pace. Missed deadlines, missing deliveries, gaps or unexpected closes fail without bursts, slowing down or reconnect masking.
- #57 Compare identical conditions only with `make load-record`: isolated Compose project, dedicated PostgreSQL with pg_stat_statements and own cleanup. Never use the shared test DB. Per offered send report top-level queries, all statements, and statements including nested FK checks. pg_stat_database only supports the count. Keep raw logs/source patches out of Git and public artifacts.
- #178 Port forwarding failed at 9,990 sockets. Use `LOAD_DIRECT_NETWORK=1`. `LOAD_SERVER_SOURCE` selects the worktree. Use `LOAD_LEGACY=1` only for pre-#146. Short windows fail. [Load harness methods](../../load/measurements-archive.md#load-harness-methods-20-57)

- #151 adopts DM performance acceptance at 10,000 connections and 2,000 sends/s with [latency/DB/memory budgets](../spec/dms.md). Mixed O5/write load must include hot bursts, notice loss, bootstrap, bounded backlog/drain and storage/WAL/lock/backup/restore costs.

- #151 Keep main fixture exactly 100 DMs/Member, with held200 separate at full mixed load for comparability. Sum samples across ten Organizations and judge each with ≥1,000 samples/class/attempt so aggregates cannot hide tails. Judge first-page/deep browse only on a separate browsing Organization at full load because the main fixture cannot supply deep continuations.

- #151 Judge absolute budgets on hourly-rented Linux servers after first deploy (#431). Developer Mac comparisons must be same-machine only (#426/#153/#196) because generator CPU is shared and there is a VM.

## Entries in other parts

Entries that also govern this area, listed by the start of the entry in that part.

- [process](process.md): `#401: deployment/load app and migrate use`
- [process](process.md): `k6 bumps are manual (Dependabot does`
- [process](process.md): `#442 Feature work comes first`, `#442 Once per milestone`
- [messages](messages.md): `#160 Mutation thresholds are fixed`, `#160 The INVALID 2026-11-16`
- [realtime](realtime.md): `#212 follows up handshake admission, listen`, `#151 DM list base limits`, `#151 B4 adopts`, `#151 coalesces discovery`
