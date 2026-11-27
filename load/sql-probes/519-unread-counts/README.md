# #519 Channel-list counts probe (A3)

DIAGNOSTIC / NOT EVALUATED. Reproduces the #519 A3 prototype: the Channel-list Unread and Mention counts as committed at `65f63307`, against the A3 counter design, plus a send micro-bench. It gives no PASS/FAIL and is not evidence for any #196 or #519 gate. The product design and its pre-registered checks are on #519.

## Run

On an idle host (the operator checks for other measurement work first):

```sh
node --test load/sql-probes/519-unread-counts/probe.test.ts
npm --prefix load run check
node load/sql-probes/519-unread-counts/run.ts --smoke --out /absolute/new/dir/outside/checkout
node load/sql-probes/519-unread-counts/run.ts --diagnostic --out /absolute/new/dir/outside/checkout
```

Smoke takes about 30 s (one cut, a 5 s bench pair) and only validates the harness. Diagnostic takes about 4 min. The runner starts one disposable `postgres:18.6` container with no network (pinned digest, `shared_buffers=512MB`, `jit=off`) and removes it at the end.

## What it does

- Migrations, `deploy/db-roles.sql`, `deploy/db-grants.sql` and `LIST_COUNTS_SQL` come from the pinned commit through `git archive`/`git show`, so later product changes do not alter the baseline. Each migration runs in its own transaction, as SQLx applies them.
- `sql/seed.sql`: 1 Organization, 1,000 Members, 200 public Channels with 2,000 Messages each (senders rotate over 200 Members). Channel 1 has 200 Topics holding 70% of its Messages. The measured Member is Member 2. Member 2 sends every 97th seq, every 89th is deleted, and every 50th mentions Member 2. Then `VACUUM ANALYZE`.
- `sql/{current,a3}-fresh.sql`: 150 more seqs per Channel with autovacuum off on `messages`, so the tail is not all-visible, as under continuous sends.
- `sql/a3-schema.sql`: the prototype A3 schema and its backfill. `sql/a3.sql` is the A3 counts query. `sql/a3-ordinals.sql` writes the ordinals that mark-read would store.
- For each cut (75, 150, 575, 2,150 unread seqs per scope), `sql/setcut.sql` places Member 2's positions (with a Topic position for every Topic). The query then runs as `fukulow_app` with RLS active and the Organization set, as a prepared statement in auto plan mode. The runner saves the second `EXPLAIN (ANALYZE, BUFFERS, SETTINGS)` in a read-only REPEATABLE READ transaction, then 30 timed executions without EXPLAIN after one warm-up, `pg_prepared_statements` counters and a checksum over every output row. Arm order alternates per cut. A checksum mismatch fails the run.
- Send: `sql/send-{current,a3}.sql` emulate the send statements in plpgsql (counter, Message, `channel_log`, Mention, Topic; no search terms). Each block runs `CHECKPOINT`, then pgbench with 8 clients for 30 s through `sql/bench.pgb`, and records the WAL between LSNs. Three pairs alternate the arm order.

## Output

`metadata.json` (commits, image id, settings, host, cache condition, repetitions), `reads.json` (per arm and cut: EXPLAIN time and shared blocks, timed samples with p50/p95, prepared counters, checksum, role/RLS check), `plans/*.json` (raw EXPLAIN), `sends.json`, `summary.md` and `status.json`. The output is a local working artifact and is not stored in Git.

## Limits

- EXPLAIN ANALYZE times include instrumentation overhead. Compare the timed p50/p95.
- The send bench runs as the superuser without RLS and emulates statements in one plpgsql call. It has no HTTP, pool, search terms, admission or network. Each 30 s block follows a `CHECKPOINT`, so full-page images inflate WAL and table growth lowers throughput over the run.
- The prototype differs from the proposed product design (DB triggers, one count table, kept Mention rows). See #519.
- One synthetic fixture on a shared Mac.

## §10 step 1: final design (`final.ts`)

DIAGNOSTIC. It compares the merged A3 design (`fd6a5949`: real triggers, backfill migration and `LIST_COUNTS_SQL`), plus the #820 UPDATE-first migration from `c672b0a4` in the final arm, with its parent `5ef561e5` on the same seed. Only the pre-registered stop rule from #519 §10 step 1 applies; it is not a gate.

```sh
node load/sql-probes/519-unread-counts/final.ts --smoke --out /absolute/new/dir/outside/checkout
FUKULOW_HOST_BUSY=/path/of/the/held/host-busy/marker \
  node load/sql-probes/519-unread-counts/final.ts --diagnostic --out /absolute/new/dir/outside/checkout
```

- **Schema:** both arms start from the parent's migrations and the same seed. The final arm then applies the A3 migration and, since the #814 fix (#820), the UPDATE-first follow-up from `c672b0a4`, each in its own transaction, as a deploy onto existing data would. The driver refuses any other A3 migration diff; unrelated migrations merged in between are not applied.
- **Reads:** at the same four cuts, as `fukulow_app` under RLS. The checksums must match and must be non-empty. The final arm's `count_drift` must stay false at every cut, and `message_counts_check` must be empty after the cuts and after the sends.
- **Sends:** `sql/send-current.sql` in both arms, because A3 does not change the app's send SQL. pgbench runs as `fukulow_app` with the Organization set as a per-database role default; RLS is checked before the blocks. 8 clients × 3 alternating pairs.
  - Each block runs `CHECKPOINT`, a 60 s warm block, then a 120 s measured block with `--log`.
  - `max_wal_size=64GB` and `checkpoint_timeout=1h` keep checkpoints out of the blocks. A block that crosses a checkpoint fails the run, after the block's results are saved.
  - A crossing is judged by server-log timestamps (`log_checkpoints=on`, `%m` prefix in UTC, both checked at start). The opening and closing starts are the first forced starts stamped at or after each `CHECKPOINT` request, on the server clock. Any start logged between them and stamped at or before the end of the measured block is a crossing. A start after the block ends, such as a WAL-driven one before the closing request, is recorded as `afterBlock` and not flagged. A `pg_stat_checkpointer` count change or a moved redo LSN up to the end of the measured block is also a crossing.
  - The log is polled until the closing start is visible (capture can lag; starts are logged in order). A log-read failure, an unreadable timestamp or 60 s without the closing start fails the block: it is never treated as clean.
  - The row is built as soon as pgbench completes. A closing `CHECKPOINT` or host-probe (`docker ps`/`docker events`) failure is recorded in the row's `errors`, the row is written to `sends.json`, and then the run fails.
  - Reported per block: tps, p95/p99 from the per-transaction log (the line count must equal pgbench's transactions), WAL bytes/send from the `pg_current_wal_insert_lsn()` delta, the `pg_stat_wal` bytes, records and full-page images, and images per WAL record.
- **Consistency check:** every `message_counts_check`, including the one in the A3 migration's backfill guard, runs under `statement_timeout = 45min` (fixed before the run; the last unbounded check took about 33 min on three blocks' rows). Drift, a timeout or any error fails the run at once; the check is never skipped. Results, with the migration as its own row, go to `checks.json` and `summary.md`. Each send block is written to `sends.json` before its check, so a failed check keeps every completed block.
- **Stop rule, fixed before the diagnostic run:**
  - Per pair, compute the final/current ratios. The rule fires when the median ratio exceeds a limit: WAL/send above 1.20, or tps below 0.90.
  - Every pair and every individual breach is reported.
  - A zero, negative or non-finite WAL/send, tps, ratio or median fails the run instead of counting as no breach (#803).
- **Run conditions:** `--diagnostic` requires the held host-busy marker and records its line in `metadata.json`. Smoke uses 5 s blocks and one cut, and only validates the harness.
- **Limits:**
  - WAL statistics are cluster-wide, so idle clones can add background WAL.
  - The send databases are reused across pairs, so the faster arm accumulates more rows.
  - Shared caches persist across blocks.
  - `docker events` returns at most the daemon's last 256 events. A container start is missed if more than 256 daemon events (any type) follow it before the post-block query; one block's own `docker exec` calls add far fewer. The query window opens at least 1 s before the pre-block `docker ps`, so a start between the two is not lost to whole-second rounding.
  - It is one plpgsql call per send, with no HTTP, pool or search terms.

### Send re-measure (`--sends-only`)

Approved by the maintainer on 2026-11-23 after the step 1 STOP; that STOP stands. Each run needs its own go.

```sh
node load/sql-probes/519-unread-counts/final.ts --smoke --sends-only --out /absolute/new/dir/outside/checkout
FUKULOW_HOST_BUSY=/path/of/the/held/host-busy/marker \
  node load/sql-probes/519-unread-counts/final.ts --diagnostic --sends-only --out /absolute/new/dir/outside/checkout
```

- **Unchanged:** the baseline and A3 pins (`c672b0a4` only adds the UPDATE-first migration), image, server settings, seed, `sql/send-current.sql` in both arms, `fukulow_app` under RLS, 8 clients and 4 threads, a forced `CHECKPOINT` then 60 s warm and 120 s measured per block, the checkpoint-crossing failure, and the stop rule.
- **Order, fixed:** blocks 1 to 6 are current, final, final, current, current, final (pairs 1 to 3, as in step 1).
- **Changed, with reasons:**
  - Reads are skipped (already decided by step 1), so no idle read databases add background WAL.
  - Each block runs on its own database, cloned from a per-arm template and dropped (`WITH (FORCE)`) after the block. In step 1 the two send databases were reused, so each block ran on the rows and autovacuum debt of earlier blocks; pair 1, the first two blocks, had current at about twice the tps of every later block.
  - Both templates get `VACUUM (ANALYZE)` before any clone, so no block pays the A3 backfill's vacuum or analyze.
  - `message_counts_check` runs on the final template and after every final block, on that block's database.
- **Host:** `--diagnostic` refuses to start a block while any other container runs, and fails a block if another container runs after it or started during it (`docker events`). Load average and containers are recorded before and after each block. The operator also holds the host-busy marker and runs no other workers.
- **Reported:** per block in run order: tps, p95/p99, WAL bytes/send, images per WAL record and per send, start and end times, host state. Per pair: both ratios and each breach. Every check with its duration.
- **No exclusion or rerun after results.** A failed run (setup, check, timeout or crossing checkpoint) is reported as failed. At most one rerun for a known setup failure, as #769 allows.
- **Time:** about 25 min of blocks, plus setup and three final-block checks (each expected well under the 45 min limit).

### F2 send comparison (`--f2`)

The Mac smoke runs one pre-F2 block followed by one F2 block, with 300 seeded Messages per Channel and 5 s warm/5 s measured per block. It verifies both migration chains, fresh main and Topic sends with Mentions under `fukulow_app` with RLS, and zero count discrepancies before and after sends. Smoke is labeled SMOKE / NOT EVIDENCE.

```sh
node load/sql-probes/519-unread-counts/final.ts --smoke --sends-only --f2 --out /absolute/new/f2-smoke
```

After a separate measurement go, use one job on the qualified Ubuntu host with the [formal v3 launcher conditions](../../harness-core/README.md#796-frequency-validity-v3). Keep the pinned image, disk and host preflights, cool-down, airflow confirmation, 5 s thermal sampling, frozen frequency floors and workload label `io.fukulow.probe=519-final`. Use `issue: 796` for launcher routing, the go for this #519 comparison, and the same full F2 source SHA in the queue's `commit` and the command. Use a clean checkout. Run `node load/launch.ts --queue /absolute/519-f2-queue.json` with this command in the job's argv.

```sh
node load/sql-probes/519-unread-counts/final.ts --diagnostic --sends-only --f2 --f2-source F2_FULL_SHA \
  --cpu-sets 'server=2,4,6,10,12,14;client=1,3,5,9,11,13;housekeeping=0,7,8,15' \
  --frequency-v3 formal --perf-helper /absolute/fukulow-perf-helper --out /absolute/new/f2
node load/sql-probes/519-unread-counts/stability.ts --stage formal --f2 \
  --queue /absolute/519-f2-queue.json --out /absolute/new/f2-placement.json
```

The installed helper must accept all 16 planned block orders. The harness checks order 16 before setup. See the [helper installation instructions](../../harness-core/README.md#796-frequency-validity-v3) to replace the older six-block helper.

- Current stays at `5ef561e5` and final applies only A3 from `fd6a5949` and UPDATE-first from `c672b0a4`. Both use `sql/send-current.sql`. Pre-F2 (`pref2`) applies the exact migration chain at `6e2d1d4d`, and F2 adds only the F2 migration. Both use the same seed with a reconstructed Create log for #620's bijection guard.
- `sql/send-pref2.sql` and `sql/send-f2.sql` mirror the Rust sequence UPSERT, Topic join and update, Message INSERT and Mention writes. Their only SQL differences are `main_appended`, `scope_appended` and `scope_append_recorded`. Both arms include #620's removal of the Create-log write and the Topic paging index. The probe measures the database writes in one routine call per send and skips application authorization, search indexing, HTTP and delivery.
- Every block uses a fresh clone, the same settings and RLS role, 8 clients/4 threads, a forced checkpoint, 60 s warm and 120 s measured. `message_counts_check` runs on the final, pre-F2 and F2 templates and after each of their blocks with the 45 min statement timeout. Migration drift outside the pinned chain fails setup. `metadata.json` records the source pins and hashes of the SQL and Rust send files for pre-F2 and F2.
- The four Williams square rows are the four pairs, in order. Each arm occupies every position once and follows each other arm once within a row.
  1. current, final, F2, pre-F2
  2. final, pre-F2, current, F2
  3. pre-F2, F2, final, current
  4. F2, current, pre-F2, final
- The 16 blocks take 48 min of pgbench work, up from 27 min, plus the first-block 150 s settle/reference, setup, checkpoints, cloning, 15 explicit consistency checks and up to 20 min of prelaunch cool-down. The launcher has no whole-job timeout. Allow for a session beyond one hour, including the extra checks. Per-block time, thermal cadence and all existing timeouts still apply.
- Use the placement report to verify the host evidence before interpreting results. `stop-rule.json` compares final with current and `stop-rule-f2.json` compares F2 with current with the existing median limits (WAL/send ≤ 1.20, tps ≥ 0.90). The summary also shows F2 vs final. Ratios use paired blocks and the probe's existing nearest-rank median (lower middle of four).
- The report-only **F2 vs pre-F2** and **pre-F2 vs current** sections show each pair and the medians. F2/pre-F2 isolates the counter change. Pre-F2/current includes the #620 and Topic paging changes together. The summary and `stop-rule-f2.json` always display the F2-only flag for a completed comparison. Median F2/pre-F2 WAL/send > 1.20 or tps < 0.90 gives `F2-ONLY REGRESSION`. Otherwise, WAL/send > 1.00 in all four pairs or tps < 1.00 in all four gives `F2-only worsening below limits`. All other results give `no F2-only regression observed`. The flag is informational.

### Send-cost attribution (`--attribution`)

DIAGNOSTIC / NOT EVALUATED. Instrumentation lowers tps. Totals are not comparable to #796 or to the stop rule. Use only the split between arms.

For the Ubuntu smoke, run the five-second send smoke on the idle host, once plain (output unchanged) and once with attribution (checks the extensions and WAL inspection on a real server; it takes no CPU sets or frequency stage).

```sh
node load/sql-probes/519-unread-counts/final.ts --smoke --sends-only --out /absolute/new/smoke
node load/sql-probes/519-unread-counts/final.ts --smoke --sends-only --attribution --out /absolute/new/smoke-attribution
```

For the Ubuntu diagnostic, use a single job in the [#796 formal launcher setup](../../harness-core/README.md#796-frequency-validity-v3). Keep the image, disk and host gates, frozen floors, and `issue: 796` for launcher routing. Supply the go for this #519 diagnostic and fresh output paths. Put the following command in the job's `command` argv, then run `node load/launch.ts --queue /absolute/519-attribution-queue.json`.

```sh
node load/sql-probes/519-unread-counts/final.ts --diagnostic --sends-only --attribution \
  --cpu-sets 'server=2,4,6,10,12,14;client=1,3,5,9,11,13;housekeeping=0,7,8,15' \
  --frequency-v3 formal --perf-helper /absolute/fukulow-perf-helper --out /absolute/new/attribution
```

Attribution requires diagnostic sends-only. Formal v3 supplies the Ubuntu placement and host gates for the same six blocks. Control changes the arm order and caps a block. Rehearsal 2 is reserved for floor qualification. The stability report rejects attribution runs.

The probe checks for 40 GiB free on PostgreSQL's WAL filesystem and retains at least 8 GiB of recent WAL. It writes `block*/attribution.json` plus `attribution-summary.json` and `attribution-summary.md`. Unavailable WAL marks attribution incomplete and preserves the block's statement and function data.
