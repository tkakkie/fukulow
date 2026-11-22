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
