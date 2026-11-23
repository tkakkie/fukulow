# #515 R1 replay SQL diagnosis

Measures the successful public Channel gap-fill path with the night 3 Part C commits. A is `4542f545` (`events` with the matching history generation) and B is `b975ffa` (`messages`). The reference HTTP p95 gap was about 0.8–1.1 ms. This probe has its own results and leaves the formal measurement record and verdict intact.

## Run

Use the repository Node version and Docker Compose. The runner uses the two revision-labelled release images from the slice 5 build for migrations only. On the idle host, prepare those images with the night 3 `--build` invocation documented by `node load/slice5/run.ts --help`. The runner checks each image label and compares applied SQLx migration checksums with the corresponding Git archive. The PostgreSQL image is pinned by each archived Compose file. The runner uses those files and the matching runtime-grant files with two isolated `fk515d-` projects. Only PostgreSQL and the migration container start. Cleanup removes the probe's projects and volumes.

```sh
node --test load/sql-probes/515-replay/probe.test.ts
npm --prefix load run check
node load/sql-probes/515-replay/run.ts --smoke --out /private/tmp/fk515d-smoke-1
# Evening before the overnight run: full fixture size, one short cell, never evidence
node load/sql-probes/515-replay/run.ts --rehearsal --out /absolute/path/to/new-rehearsal
# On an idle measurement host
node load/sql-probes/515-replay/run.ts --recorded --out /absolute/path/to/new-output
```

The output directory must be new, outside the checkout and have an existing parent. Both modes use one Organization, 4,000 Members and synthetic Session keys, 200 public Channels and 17-byte Messages. Smoke uses 20,000 and 10,000 Messages in the two populated Channels, with 20 timed requests per arm and cell. It serves only to validate the harness. Rehearsal uses the recorded fixture with the first cell and one B/A block of 50 requests. Recorded mode uses 1,000,000 and 100,000 Messages and 1,000 timed requests per arm and cell. All modes use the slice 5 DB settings, pg_stat_statements, prefill and Channel log builders, insert-autovacuum reloptions, first freeze/analyze and checkpoint, then analyze, checkpoint and idle for each cell. Seed, settle and VACUUM run without the 10 s measurement `statement_timeout` ([harness core](../../harness-core/README.md)); every measured statement keeps it.

## Read the output

- `metadata.json` records commits, image digests, verified migrations, fixture checksums, settings, role and per-table RLS checks, cache conditions, order and repetitions. The host snapshots are taken before each timing block. `status.json` records completed blocks and the overall run status.
- `{A,B}/statements.json` contains the ordered sequence, extracted SQL, and Rust references at the pinned commits. The summary counts SQL, synchronous pool checkout checks and asynchronous return checks separately. Auth uses a read-only snapshot in both arms. A runs visibility, the shared-barrier/watermark transaction, then the authorized replay page. B checks visibility and reads its page within a single read-only history snapshot. Both aggregate Mentions in the page statement. A also reads history generation there.
- Plan files contain raw `EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON)`, summarized plans, and `pg_prepared_statements` counters. Each mode starts on a fresh client, including the first execution in auto mode. Plan cursors use reader 0's first measured Part C position. SQL fetches 51 rows for the HTTP limit of 50. The runtime uses the application's statement-local Organization wrapper, with `statement_timeout=10s`, `jit=off` and active RLS. Transaction utility commands run in order and have no EXPLAIN plan.
- A's controls include a Channel log page without hydration and the full page with either LATERAL plus OFFSET 0 or a plain join. For the join comparison, both variants set the same Organization before planning and retain the wrapper. Both arms also execute the same query statements as the disposable table owner (a superuser) in rolled-back transactions, with RLS inactive. Use these as plan controls.
- Timing runs in auto mode without EXPLAIN. Each block uses one persistent psql client for per-statement measurements and one separate pgbench client for whole-sequence measurements. Both use SQL PREPARE/EXECUTE over TCP loopback, so the SQL text and parameter types are shared across plan and timing probes. Each client warms up before timed samples. Blocks alternate B/A and A/B. All four Part C reader coordinates feed the cursor generator, using one fixed synthetic Member and Session to hold auth inputs constant. The complete recorded schedule covers reader iterations 10 through 259. Raw timings include the discarded warmups. The JSON joins independent psql and pgbench observations by cursor schedule index and provides p50/p95 via nearest rank.
- `summary.md` compares the isolated SQL sequence with the reference HTTP gap. The probe runs on a settled, writer-free fixture with one client at a time. Concurrent barrier wait, app-to-DB network latency, pool scheduling, Rust decoding and HTTP response work remain open. The SQLx round-trip counts come from the app and driver source.

Keep the raw plans and samples with the report. Local outputs are temporary working artifacts under workflow §14. Retention and publication of recorded evidence are separate.
