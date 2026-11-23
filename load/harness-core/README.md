# Shared measurement harness core (#719)

Plumbing that every measurement harness needs, so a fix lands once. New harnesses use it, and existing ones move over when they are next changed. Judgement rules, gates and criteria stay in each harness and never change here.

- `postgres.ts`:
  - TCP readiness. The postgres image's init server is socket-only, and a socket check can pass just before it stops.
  - Setup sessions without the measurement `statement_timeout`.
  - SQLSTATE-only error text.
- `host.ts`:
  - Docker VM disk headroom, measured from a throwaway container. Host `statfs` does not see Docker Desktop volumes.
  - Pinned, clean harness commit.
  - New output directory.
- `stages.ts`: `--smoke | --rehearsal | --recorded`, plus `status.json` with `stage`, `sampling` and `outcome`.

## Run rules (maintainer decisions, 2026-11-21 and 2026-11-22, #769)

These rules stop invalid runs early and keep a failure from being paid for twice. Criteria, thresholds and VALID/INVALID rules never change under them.

- **Start:** any time of day, but only after the maintainer's go in chat. An approval of a run, a schedule or a deadline is not the go. One job at a time, on an idle host (no builds, AI workers or E2E).
- **Before the run:**
  - Plan review: before a new or changed harness is rehearsed, one AI review lists every way the run could end INVALID or NOT EVALUATED (for example statistics, caches, seed variance, sampling bias, host contention). Each item gets a preflight check, a fail-fast rule, or an accepted-risk line in the record.
  - Rehearsal: before asking for the go, run each queued job with `--rehearsal`, DIAGNOSTIC jobs included. It uses the recorded fixture size and runs setup end to end (build, migrations, seed, settle, readiness, headroom) with the recorded validity checks, then one short cell and the aggregation on that output. A rehearsal is never evidence. Fix every failure before asking for the go.
  - Fail fast: the harness checks validity in setup and again after the first measured block (sample counts, required phases, trace loss), so an invalid run stops within minutes.
- **Failures:**
  - `outcome: setup-failure` means the run stopped before the first measured sample. It is not a result. If the cause is known and fixed, the job may rerun once in the same chain without a new go, logged in the chain log and the record.
  - `outcome: result-failure` means sampling had started. It is a result and never reruns in the same chain.
  - No blind rerun: after INVALID or NOT EVALUATED, nothing reruns until the cause is found and fixed and the fix passes a rehearsal. If the cause cannot be identified, the options go to the maintainer.
