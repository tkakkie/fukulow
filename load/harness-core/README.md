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
- `host-record.ts` (#796): the host record. It covers CPU model, governors, max frequency per CPU, boost, RAM and swap, AC, temperatures, disk, Docker, update jobs, sleep targets and the snap hold.
  - `linuxViolations` lists the unmet Linux measurement conditions.
  - `node load/host-record.ts --out FILE --check` exits 3 on any violation.
- `cpusets.ts` (#796): `--cpu-sets "server=LIST;client=LIST"`, checked to be disjoint. Processes are pinned with `taskset`, and the pin is read back from `/proc/<pid>/status`.

## Launching runs (#867)

`node load/launch.ts --queue FILE` replaces the hand-written waiter scripts on macOS and Linux. The queue lists the approved jobs in order, each with its Issue, pinned commit, worktree, command, output and the maintainer's go quoted from chat.

The launcher:
- waits for an idle host, then claims `HOST-BUSY` and releases it on every exit;
- runs the preflight (pinned clean tree, Node, containers, platform conditions, free disk) and the job's own gate;
- captures PostgreSQL logs;
- runs each job once and writes one `chain.log`.
- for a job with cooling fields (#796):
  - `requireHost` lists boost, per-CPU boost, platform profile and hwmon fan-control values that must hold before the job; unreadable or different is a STOP;
  - `cooldown` waits until k10temp Tctl is at most `maxTctlC`, and STOPs after `maxWaitSeconds`; every reading goes to `<job>-cooldown.json`;
  - `cooldown` measures the deadline on the monotonic clock after each Tctl read, so a reading after `maxWaitSeconds` or a wall-clock step is a STOP. Right before the spawn, after the gate, Tctl and `requireHost` are checked again into `<job>-launch-check.json`;
  - `thermalSampleSeconds` appends a `thermal.ts` sample (per-CPU `cpuinfo_avg_freq`, hwmon temperatures and fans) to `<job>-thermal.jsonl` while the job runs. The preflight and the first recorded sample need every CPU readable, or the job does not start. A failed read stays in the file as an error line, and a failed write stops the job;
  - `confirmations` records the maintainer's quoted confirmations of conditions the host cannot read (for example L3 airflow).
- runs each job in its own process group. A signal or a failed sampler write takes one stop path. Before `HOST-BUSY` is released, every started process group must be gone (SIGTERM, then SIGKILL on a bounded timer that never waits on the child's exit), containers with the job's `workloadLabel` are removed, and no container at all may still run; otherwise `HOST-BUSY` stays held. A job with an `image` needs a `workloadLabel`;
- writes `session.json` (session id, queue, outcome, jobs with outputs, labels, exits and confirmations, `hostBusy`), which a judge binds to. The session id is in every chain record and thermal line, in the `HOST-BUSY` marker, and in each gate and job's `FUKULOW_LAUNCH_SESSION`; a job's chain record left by an earlier session is a STOP.

A STOP or a failed job ends the queue. Nothing reruns: a `setup-failure` rerun under the rules below is a new queue entry with its own quoted go. Sleep prevention is `caffeinate` on macOS. On Linux it is the masked sleep targets, which are a preflight condition.

## Run rules (maintainer decisions, 2026-11-21 and 2026-11-22, #769)

These rules stop invalid runs early and keep a failure from being paid for twice. Criteria, thresholds and VALID/INVALID rules never change under them.

- **Start:** any time of day, but only after the maintainer's go in chat. An approval of a run, a schedule or a deadline is not the go. One job at a time, on an idle host (no builds, AI workers or E2E).
- **Before the run:**
  - Plan review: before a new or changed harness is rehearsed, one AI review lists every way the run could end INVALID or NOT EVALUATED (for example statistics, caches, seed variance, sampling bias, host contention). Each item gets a preflight check, a fail-fast rule, or an accepted-risk line in the record.
  - Rehearsal: before asking for the go, run each queued job with `--rehearsal`, DIAGNOSTIC jobs included. It uses the recorded fixture size and runs setup end to end (build, migrations, seed, settle, readiness, headroom) with the recorded validity checks, then one short cell and the aggregation on that output. A rehearsal is never evidence. Fix every failure before asking for the go.
  - Disk capacity (#788, d3r `--backfill-only` and formal runs): within 60 minutes before the launch, run `node load/capacity/d3r.ts --stage=backfill-only|formal --out=OUT --rehearsal=DIR [--from-backfill=DIR] --report=FILE` and keep the report in the run's record. The launch may start only if the report says `CAPACITY OK` and its `out`, `backfill` (formal), `rehearsal` and `docker` (context, endpoint, daemon id, storage) equal what the launch uses. `STOP`, a refusal, or any mismatch blocks the run; changing the output or source location needs a new report.
  - Fail fast: the harness checks validity in setup and again after the first measured block (sample counts, required phases, trace loss), so an invalid run stops within minutes.
- **Failures:**
  - `outcome: setup-failure` means the run stopped before the first measured sample. It is not a result. If the cause is known and fixed, the job may rerun once in the same chain without a new go, logged in the chain log and the record.
  - `outcome: result-failure` means sampling had started. It is a result and never reruns in the same chain.
  - No blind rerun: after INVALID or NOT EVALUATED, nothing reruns until the cause is found and fixed and the fix passes a rehearsal. If the cause cannot be identified, the options go to the maintainer.
