# Search engine harnesses

## #689 item 3 timing-leak harness

The paired d3r runner lives in `d3r-leak/`. Its independent manifest pins the production Search source, migrations, PostgreSQL image, settings, seeds and fixture sizes. Each arm gets a fresh database on that schema. Raw pgbench logs, transaction samples, fixture assertions and generic EXPLAIN plans are saved by pair.

1. Prepare the harness PR with the fixture assignments and configurable P candidate count.
2. Have an independent reviewer check the harness and its refusal, invalidation and verdict paths against the pre-registration.
3. Run the smoke on the pinned Node version with the manifest's PostgreSQL image available locally. It uses small fixtures, exercises the judged pairs and tries the supplied P counts. The output is labelled **SMOKE / NOT EVIDENCE** and has no verdict. Use the observed ratios and the registered 1.5 target to freeze K in the PR before the go.

   ```sh
   node load/search-engines/d3r-leak/run.ts --smoke --out=/tmp/fukulow-689-leak/smoke --k=32,128,512
   ```

4. After freezing K, rehearse on the #796 Ubuntu host with `--rehearsal --out=<new-directory>`. This runs the full-size fixtures, one block per arm, aggregation and verified cleanup. Output is labelled **REHEARSAL / NOT EVIDENCE** and has no verdict.
5. Obtain the maintainer's explicit go for one formal run. Both rehearsal and formal runs use a clean checkout and a fresh output directory. The caller owns `runs/HOST-BUSY` and supplies the launcher job and session. Run the coordinator on the #796 housekeeping CPUs. PostgreSQL and pgbench use separate #796 CPU sets.
6. Take the formal verdict only from that run, after verified cleanup. There is no automatic rerun.

The formal command accepts `--formal --out=<new-directory>`. The manifest freezes the E, S, V and A/A assignments and K = 128. K is the smallest smoke candidate (32, 128, 512) whose P ratios met the registered 1.5 target at both p50 and p95: 2.27 and 2.06 (32 gave 1.34 and 1.41). The full-size rehearsal must complete before the formal go.

For V, each arm's fixture record contains SHA-256 fingerprints of the complete Message and search-term rows. Separate per-arm visibility records capture the heap pages occupied by the C2-Q4 slots before and after sampling. Both heaps must have every such page all-visible in the vacuumed reference and every such bit clear in the delayed-insert arm.

## #689 item 4c Phase A churn harness

Phase A reports the growth of `message_search_terms` under real Sends and the effect of **W2 MODEL** Edit and Delete transactions on the disposable fixture. A W1 term mismatch is a defect. A W2 mismatch invalidates the MODEL. Phase A has no item 4c verdict.

1. Prepare the harness PR with the independent `manifest-d3r-churn-v20.json`. Have an independent reviewer compare the implementation, tests and refusal paths with the approved [pre-registration](https://github.com/tkakkie/fukulow/issues/689#issuecomment-7219092045) and the three maintainer decisions.
2. Build the production release image from a clean checkout of the manifest's `sourceCommit`, label it `org.opencontainers.image.revision` with that SHA, and record its immutable image ID. Make the manifest's pinned PostgreSQL and k6 images available locally. Use the pinned Node version and run from the harness checkout root.
3. Smoke on macOS or Ubuntu with a new absolute output directory outside the checkout. Smoke uses one real Send, a small seeded MODEL, untimed Search first pages and all six snapshot transitions. It skips the rate windows, latency capture, `EXPLAIN ANALYZE` and idle wait.

   ```sh
   node load/search-engines/d3r-churn/run.ts --smoke --messages=100 --out=/tmp/689-churn-smoke --app-image=sha256:APP_IMAGE_ID
   ```

4. Rehearse at full size, using the launcher on the #796 Ubuntu host with a clean harness checkout. Pin the coordinator to the #796 housekeeping CPUs in the queued command. App and PostgreSQL use the server set, k6 and pgbench use the client set. The launcher holds `runs/HOST-BUSY`; queue the approved command, pinned harness commit, and a new output directory. Budget space for fixture growth, the temporary lookup index during concurrent reindex, and archive copies if used.

   ```sh
   node load/search-engines/d3r-churn/run.ts --rehearsal --out=/absolute/new-rehearsal --app-image=sha256:APP_IMAGE_ID
   ```

5. Obtain the maintainer's explicit go for one formal run. Queue the same command with `--formal` and a fresh output directory. The harness refuses both full-size stages outside the launcher. There is no automatic rerun.

Use `--preserve-backfill` to keep the verified pre-W0 cluster and its receipt. Use `--from-backfill=/absolute/previous-phase-a-output` to restore it in the next run. The archive must match the manifest, PostgreSQL image, fixture size, seed and SQLx migration history. The runner verifies restored terms again. Phase A archives come from the production `migrate` command. The earlier d3r v18 archives lack that history.

The fixture uses the pinned d3r generator. Before W0 the harness removes empty Channel watermarks, sets empty Topic summaries to zero Messages with null bounds, and verifies every Channel's contiguous positions. W1 uses the M1/S1 k6 path at 50 Sends/s for one hour, the generator's body distribution and the S1 sustained-step rule. Four Members send across 200 public Channels in the Organization used by the Search queries. W2 MODEL freezes the non-deleted Message population at its start. It interleaves disjoint sets of floor(10%) Edit and floor(5%) Delete targets selected by the fixed seed, one operation each over the hour with 50 slots/s. W3 takes snapshots after 30 minutes of idle autovacuum, plain VACUUM of the term heap, and concurrent reindex of the lookup index.

`settings.json` records all effective PostgreSQL settings and the override inventory. The cluster uses stock PostgreSQL 18.6 settings with autovacuum on. Measured SQL app sessions mirror the production 10 s statement timeout and JIT off. Search uses the production 2 s transaction timeout and forced generic plan. The backfill disables the statement timeout locally, and direct fixture RLS probes disable it on their own app connection. W1 uses the raised M1/S1 Send limiter, the app runs as `fukulow_app` on the private Docker network, and FORCE RLS is verified.

`report.json` identifies all snapshots and records any INVALID reason. Stage files retain raw five-minute counters, WAL deltas, per-query samples, EXPLAIN JSON and both consistency checks. WAL per operation uses the Message insert or update counter delta for that interval. PostgreSQL statistics can lag a commit, and the WAL delta includes background activity. Keep the raw files outside Git.
