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

## Run rules (maintainer decisions, 2026-11-21)

- **Start:** any time of day, but only after the maintainer's go in chat. An approval of a run, a schedule or a deadline is not the go. One job at a time, on an idle host (no builds, AI workers or E2E).
- **Rehearsal:**
  - Before asking for the go, run each queued job with `--rehearsal`.
  - It uses the recorded fixture size and runs setup end to end (build, migrations, seed, settle, readiness, headroom). Then it runs one short cell and the aggregation on that output.
  - A rehearsal is never evidence. Fix every failure before asking for the go.
- **Setup failure:**
  - `outcome: setup-failure` means the run stopped before the first measured sample. It is not a result.
  - The harness may be fixed and the job rerun once in the same chain, without a new go, logged in the chain log and the record.
- **Result failure:** `outcome: result-failure` means sampling had started. It is a result and never reruns.
