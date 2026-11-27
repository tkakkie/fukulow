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
