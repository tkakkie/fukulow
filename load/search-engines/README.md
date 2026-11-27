# Search engine harnesses

## #689 item 3 timing-leak harness

The paired d3r runner lives in `d3r-leak/`. Its independent manifest pins the production Search source, migrations, PostgreSQL image, settings, seeds and fixture sizes. Each arm gets a fresh database on that schema. Raw pgbench logs, transaction samples, fixture assertions and generic EXPLAIN plans are saved by pair.

1. Prepare the harness PR with the fixture assignments and configurable P candidate count.
2. Have an independent reviewer check the harness and its refusal, invalidation and verdict paths against the pre-registration.
3. Run the smoke on the pinned Node version with the manifest's PostgreSQL image available locally. It uses small fixtures, exercises the judged pairs and tries the supplied P counts. The output is labelled **SMOKE / NOT EVIDENCE** and has no verdict. Use the observed ratios and the registered 1.5 target to freeze K in the PR before the go.

   ```sh
   node load/search-engines/d3r-leak/run.ts --smoke --out=/tmp/fukulow-689-leak/smoke --k=32,128,512
   ```

4. Rehearse the full-size fixtures through setup, one short cell, aggregation and cleanup on the #796 Ubuntu host. The rehearsal is diagnostic.
5. Obtain the maintainer's explicit go for one formal run. Use a clean checkout and a fresh output directory. The caller owns `runs/HOST-BUSY` and supplies the launcher job and session. Run the coordinator on the #796 housekeeping CPUs. PostgreSQL and pgbench use separate #796 CPU sets.
6. Take the formal verdict only from that run, after verified cleanup. There is no automatic rerun.

The formal command accepts `--formal --out=<new-directory>`. It is currently blocked pending the E scope and query, S query, V matched scope, query and reference fixture, and the A/A few-arm reference. The full-size rehearsal entry point also remains pending those assignments.
