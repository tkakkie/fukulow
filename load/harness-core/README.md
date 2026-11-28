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
- `cpusets.ts` accepts `--cpu-sets 'server=LIST;client=LIST[;housekeeping=LIST]'` with pairwise disjoint sets. #796 v3 requires all three sets and verifies container cpusets and process pins.
- `provenance.ts` (#866): `harnessHashes(paths)`, the SHA-256 of each listed file. A missing file, an empty or duplicate list, an absolute or escaping path, or a symlink resolving outside the checkout throws.
- `provenance-coverage.ts` (#866, tests only): `missingFromProvenance(entries, list)` returns the entries and every local file they reach that the list lacks. It follows imports (type-only included) and `new URL('<literal>', import.meta.url)` loads, transitively. Any other `import.meta` form that may name a file (a non-literal URL, `import.meta.dirname`, a directory URL) throws; teach the walker the form or use the literal one. Working-directory reads such as `readFileSync('compose.yml')` are not seen, so those stay listed by hand.
- `nearest-rank.ts` (#866): `nearestRank(sorted, fraction, outOfRange)` and `nearestRankIndex(length, fraction, outOfRange)` for samples that are not plain numbers (the #515 app rows, sorted by latency with an ID tie-break). Empty input gives `undefined`. `outOfRange` keeps each copy's clamping: `clamp`, `clamp-low`, `clamp-high` or `none`, listed per copy in the source; the default `reject` throws.
- `checkout.ts` (#866): `outsideCheckout(path, checkout, symlinks)`. A relative path is never outside.

Adoption (#866): a harness moves to these only when it next changes, never in a frozen file. It keeps a thin local wrapper for its scale and its empty-input result (null, NaN, 0, a throw), because those feed different INVALID / NOT EVALUATED rules. Each adoption adds a same-input equality test against the old copy. `nearest-rank.test.ts` and `checkout.test.ts` hold such wrappers for every current copy.

`outsideCheckout` wrappers (checkout from the working directory, as today):
- `proxy-target.ts` and its callers: `resolve` mode on the raw path; a symlink is followed both ways.
- `dms-workload.ts` (dms-record, dms-seed, dms-instrument, dms-formal-seed) and `log-compare/options.ts`: `lexical` mode on `resolve(raw)`. Keep the `resolve`: dms-record accepts `../out/new` only through it.
- `dms-formal-config.ts` `external`: keep its own realpath step (a missing parent throws), then `lexical` mode.
- `signin.ts`, `signin-owner.ts`: `lexical` mode on `resolve(raw)`. One decision changes: a checkout child whose name starts with `..` (`<checkout>/..cache`) is accepted today and rejected by the kit. The adoption PR must say so.

Medians are named here, not unified, because their even-count and empty results differ:
- mean of the two middle values: `proxy-judgment.ts`, `signin-owner-burst-locks.ts`, `revocation-holds-memory.ts` (empty: NaN), `dms-formal-seed-samplers.ts` (empty: null), `thermal.ts`, `search-engines/diagnose-870/judge.ts`;
- upper middle value `sorted[floor(n / 2)]`: `slice5/judge.ts`, `hot-plans/fanout.ts`;
- middle of exactly three: `search-m1-report.ts`;
- lower middle by nearest rank, clamped, empty throws: `sql-probes/519-unread-counts/probe.ts` (`quantile(xs, 0.5)`, the stop-rule median);
- lower middle by nearest rank, empty `undefined`: `search-engines/summarize.ts` (frozen).

## Launching runs (#867)

`node load/launch.ts --queue FILE` replaces the hand-written waiter scripts on macOS and Linux. The queue lists the approved jobs in order, each with its Issue, pinned commit, worktree, command, output and the maintainer's go quoted from chat.

The launcher:
- waits for an idle host, then claims `HOST-BUSY` and releases it on every exit;
- runs the preflight (pinned clean tree, Node, containers, platform conditions, free disk) and the job's own gate;
- captures PostgreSQL logs;
- runs each job once and writes one `chain.log`;
- passes each gate and job `FUKULOW_HOST_BUSY` (the held marker) and `FUKULOW_LAUNCH_JOB` (its name), so a harness can refuse to start outside the launcher.
- for a job with cooling fields (#796):
  - `requireHost` lists boost, per-CPU boost, platform profile and hwmon fan-control values that must hold before the job; unreadable or different is a STOP;
  - `cooldown` waits until k10temp Tctl is at most `maxTctlC`, and STOPs after `maxWaitSeconds`; every reading goes to `<job>-cooldown.json`;
  - `cooldown` measures the deadline on the monotonic clock after each Tctl read, so a reading after `maxWaitSeconds` or a wall-clock step is a STOP. Right before the spawn, after the gate, Tctl and `requireHost` are checked again into `<job>-launch-check.json`;
  - `thermalSampleSeconds` appends a `thermal.ts` sample (per-CPU `cpuinfo_avg_freq` and `/proc/stat` counters, hwmon temperatures and fans) to `<job>-thermal.jsonl` while the job runs, at fixed monotonic targets (no drift), each line with its monotonic time; the period used goes to `session.json`. The preflight and the first recorded sample need every CPU's frequency and counters readable, or the job does not start. A failed read stays in the file as an error line, and a failed write stops the job;
  - the counters exist because an idle CPU's `cpuinfo_avg_freq` is the `cpuinfo_min_freq` placeholder, not a measurement (Ubuntu host, 2026-11-24). `blockThermal` keeps per CPU only the readings of ticks where it was active (busy = 1 − (idle + iowait delta) / total delta since the previous tick); unreadable frequency or counters (anything but non-negative integers, a positive integer for kHz), any counter going backwards (guest included) or the total not advancing, or no predecessor tick fail the set and count the tick as failed. Thresholds are compared in integers. The #796 v3 report replays that rule for comparison. The live frequency verdict uses the grouped counters below;
  - `confirmations` records the maintainer's quoted confirmations of conditions the host cannot read (for example L3 airflow).
- for a job with `thermalSampleSeconds`, takes the journal cursor before the start (unreadable: the job does not start) and records every wall-clock set event after it in `<job>-clock-events.json` (chronyd steps and detected jumps, systemd and timedated clock changes, clock commands run through sudo), so a step that is undone between two clock comparisons is still seen;
  - limits of that check (verified on the Ubuntu host, 2026-11-24, without changing its clock): it sees only what is logged. Not seen: a clock set from a root shell (sudo logs only the shell), by a program calling `clock_settime`/`adjtimex` itself, or from a container with `CAP_SYS_TIME`; systemd's own "Time has been changed" (logged at debug level only); chrony slewing, since `makestep 1 3` steps only in the first three updates and slews after that, unlogged (slewing also changes the monotonic rate); a sudo attempt that failed authentication (nothing is logged); entries journald drops under rate limiting. An unreadable cursor or a failed read makes the run INVALID, it is never read as "no events";
- runs each job in its own process group. A signal or a failed sampler write takes one stop path. Before `HOST-BUSY` is released, every started process group must be gone (SIGTERM, then SIGKILL on a bounded timer that never waits on the child's exit), containers with the job's `workloadLabel` are removed, and Docker is then watched for 15 s: a container live at any poll that was not running at the claim (new, only created, or a stopped one started again, for example a start in flight when its client died), or one created since the claim and still present at the end, keeps `HOST-BUSY` held. A start that completes after the last poll, just before the marker is removed, is not seen (a check-then-release limit; the 15 s settle covers a start in flight when its client died). A job with an `image` needs a `workloadLabel`;
- writes `session.json` (session id, queue, outcome, jobs with outputs, labels, exits and confirmations, `hostBusy`), which a judge binds to. The session id is in every chain record and thermal line, in the `HOST-BUSY` marker, and in each gate and job's `FUKULOW_LAUNCH_SESSION`; a job's chain record left by an earlier session is a STOP.

A STOP or a failed job ends the queue. Nothing reruns: a `setup-failure` rerun under the rules below is a new queue entry with its own quoted go. Sleep prevention is `caffeinate` on macOS. On Linux it is the masked sleep targets, which are a preflight condition.

## #796 frequency validity v3

The helper accepts block orders 1–16 in both `block` and `control` mode. Before setup, the send harness runs `--check-order ORDER` with the largest planned order against the installed helper. This checks the range without opening perf counters. Replace binaries installed before this check was added.

For an authorized installation, build and install from the checkout root on x86-64 Ubuntu. Set `MEASUREMENT_GROUP` to the measurement user's group.

```bash
cargo build --release --locked --manifest-path load/harness-core/perf-helper/Cargo.toml
sudo install -d -o root -g "$MEASUREMENT_GROUP" -m 0750 /opt/fukulow-perf
sudo install -o root -g "$MEASUREMENT_GROUP" -m 0750 load/harness-core/perf-helper/target/release/fukulow-perf-helper /opt/fukulow-perf/fukulow-perf-helper
sudo setcap cap_perfmon=ep /opt/fukulow-perf/fukulow-perf-helper
getcap /opt/fukulow-perf/fukulow-perf-helper
```

Keep `perf_event_paranoid=4`. The launcher and pgbench run without that capability. After the separate permission-check go, run the installed binary with `--check` as the launcher user. It applies F1 to a one-second sample on each CPU. Retain its output and exit status. STOP on a nonzero exit.

Reserve both SMT siblings of core 0 (boot CPU and observed background activity) and core 7 (observed GPU and NVMe IRQs). Each workload gives up one core to make room for background work while keeping equal sets, whole cores and the original even/odd placement. CPU 6 stays measured to check whether moving background work resolves the first-reference STOP on that CPU. Wi-Fi stays up and its IRQ moves when the kernel permits it.

The #796 host setup applies at boot (#996). Use rootful Docker with the systemd driver on cgroup v2. From a clean checkout of `main`, the maintainer installs it once on the idle Ubuntu host and reboots:

```bash
sudo "$(command -v node)" load/harness-core/boot-796.ts install --measurement-user USER
sudo systemctl reboot
```

`boot-796.ts` installs the versioned files in `boot-796/` and refuses them if they disagree with `frequency-layout.ts`:
- `fukulow796.slice` (`AllowedCPUs=1-6,9-14`), and housekeeping `AllowedCPUs=0,7,8,15` drop-ins for `init.scope`, `system.slice`, `user.slice`, `containerd.service`, `docker.service` and `tailscaled.service`;
- `fukulow796-host.service` (oneshot, enabled, after the daemons, `fukulow-cpu-performance` and `multi-user.target`, since Ubuntu orders `power-profiles-daemon` after that target), which starts the slice and `power-profiles-daemon` (on `multi-user.target` it would otherwise start later by D-Bus activation and re-apply its saved profile) and runs `frequency.sh` (`powerprofilesctl set performance`, platform profile `performance`, boost 0 globally and per policy, governor `performance`, every `scaling_max_freq` 2000000) and `affinity.sh` (workqueue and default IRQ mask `8181`, every writable IRQ to `0,7,8,15`, kthreadd and its children pinned to housekeeping);
- an `irqbalance.service` mask, `multi-user.target` as the default target (no graphical session) and `/etc/default/grub.d/fukulow-796.cfg` with `irqaffinity=0,7,8,15`, so IRQs that never fire (IRQ 27, AMD-Vi) boot on housekeeping; install runs `update-grub`.

Install records the previous default target and irqbalance mask in `/etc/fukulow-796/install-state.json`. A second install changes nothing. A failed `daemon-reload` or `update-grub` leaves `/etc/fukulow-796/reload-pending.json`, so `check` fails and the next install or uninstall reruns it. The scoped sudoers entry below stays separate. After each boot, verify as the measurement user: `node load/harness-core/boot-796.ts check --measurement-user USER` exits 0, `systemctl is-active fukulow796-host.service` prints `active`, `powerprofilesctl get` prints `performance`, and `sudo journalctl -b -u fukulow796-host.service` shows the unit's run with no failed IRQ write. Then run the pre-go checks below. This setup is #796-only: before any other series, after any pending frequency restoration, run `sudo "$(command -v node)" load/harness-core/boot-796.ts uninstall` and `sudo systemctl reboot`. [Ubuntu cpuset setup](https://ubuntu.com/real-time/docs/how-to/isolate-workload-cpusets/) · [Docker cgroup parent](https://docs.docker.com/reference/cli/dockerd/#default-cgroup-parent)

Investigate each failed IRQ write. If a writable IRQ's configured or effective mask fails the host check, correct its routing, or run `sudo systemctl restart fukulow796-host.service` on the idle host, before proceeding. Per-CPU kworkers, local timers, work-triggered IPIs, kernel-managed IRQs and threaded NAPI can still run on measured CPUs. Kthreads created after the boot service fall outside the kthreadd pin, so only the readbacks can detect new movable kthreads outside housekeeping. The report requires both housekeeping readbacks (`frequency-host-affinity.json` before calibration and `frequency-host-affinity-after.json` after container cleanup) and `frequency-container-cpusets.json`. [Linux IRQ interface](https://www.kernel.org/doc/html/latest/core-api/irq/irq-affinity.html) · [Managed IRQs](https://www.kernel.org/doc/html/latest/core-api/irq/managed_irq.html)

Use `load/launch.ts --queue FILE` with a new quoted #796 go for each diagnostic stage. Use a single job for each diagnostic, with `thermalSampleSeconds: 5`, `cooldown: {maxTctlC: 50, maxWaitSeconds: 1200}`, `requireHost: {boost: "0", policyBoost: "0", platformProfile: "performance"}`, the L3 `airflow` confirmation and workload label `io.fukulow.probe=519-final`. Run `node load/sql-probes/519-unread-counts/final.ts --diagnostic --sends-only --cpu-sets 'server=2,4,6,10,12,14;client=1,3,5,9,11,13;housekeeping=0,7,8,15' --frequency-v3 STAGE --perf-helper BINARY --out NEW_DIRECTORY`. Keep the #519 image and disk preflight. The two containers use separate cpusets under `fukulow796.slice` and share a private network namespace for an abstract Unix socket. Produce a fresh report via `node load/sql-probes/519-unread-counts/stability.ts --stage STAGE --queue FILE --out NEW_REPORT`.

- **Control (`control`).** Pass `--permission-check FILE` with `report` (absolute stdout JSON path), `sha256`, `exit: 0`, and the check go's `quote` and `date`. The report must match the helper and boot. Run three fresh clones of the block-1 arm. Start phase 1 cool, cap all 16 policies at 1.7 GHz for phase 2 warmup and measurement, then verify restoration before phase 3. Scope noninteractive sudo to the fixed control writes via `/usr/bin/tee` and the fixed observer command below. Run the launcher and pgbench unprivileged. Unconfirmed restoration leaves `frequency-restore-pending.json` and holds HOST-BUSY. Keep the boundary sweeps and the control sweep at the start of the 10 s tail. Run CHECKPOINT, a 30 s settle and a 120 s idle reference before the clone in each control phase and before block 1 in Rehearsal 2 and formal, inside that block's policy scope and outside turbostat. Recheck a cool baseline for control block 1.
- **Rehearsal 2 (`rehearsal2`).** After control review, pass `--control-review FILE` to the job and report command. This JSON contains the control report's absolute `report` path, `sha256`, and the review's `quote` and `date`. Only this stage probes and checks the live pgbench and PostgreSQL CPU masks. The six-block report records both judgments, their per-block/set disagreements and v3's two floor results. The legacy replay has no vote in the v3 verdict.
- **Formal (`formal`).** After Rehearsal 2 review and a separate Go B, the pinned checkout must contain `load/sql-probes/519-unread-counts/frequency-floors.json`. This reviewed artifact has `version: 3`, `control` and `rehearsal2` reviews (each `quote`, `date`, `sha256`), and `floors` (`server` and `client`, each a pair of exact decimal-string integers for the Hz numerator and denominator). Keep the reviewed control report readable at the absolute `control.report` path; the harness verifies its SHA-256, valid control verdict and exact floor proposal before accepting the freeze. Three consecutive six-block runs keep the 5% TPS and 2% WAL/send spreads. Any INVALID run fails the series. The report command accepts newly collected v3 evidence only.

Freeze the following rules before running. For either measured set the idle reference STOPs at 3 of 6 CPUs reaching F (1,000 ms), or at any measured CPU reaching 500 ms, normalized to 120 s. F4 requires 3 of 6 qualifying CPUs and at least 3 from the block-1 cohort in each set. Both counts preserve the half-set rule. F5 ranks the 3–6 block-1 votes, filling missing votes at the low end and then the high end. Take the middle vote for an odd cohort and the exact mean of both middle votes for an even cohort. A bound whose middle rank is missing is open in that direction. Straddling 19/20 is INVALID, and equality qualifies as clear. Housekeeping CPU readings and C0 attribution remain diagnostic.

Turbostat must briefly migrate across all CPUs for its opening and closing snapshots. Allow exactly the following sudoers command for the measurement user via `visudo`, replacing `MEASUREMENT_USER`. Remove the entry after the control. The scored observer scope runs during the capped measurement and tail. [systemd-run](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html)

```sudoers
MEASUREMENT_USER ALL=(root) NOPASSWD: /usr/bin/systemd-run --scope --quiet --collect --slice\=-.slice --unit\=fukulow796turbostat.scope --property\=AllowedCPUs\=0-15 --property\=RuntimeMaxSec\=180s -- /usr/bin/turbostat --quiet --show CPU\,TSC_MHz --add msr0xe8\,u64\,cpu\,delta\,APERF --add msr0xe7\,u64\,cpu\,delta\,MPERF -- /usr/bin/cat
```

Before the Control go, record a passing `sudo visudo -c` with sudo-rs on the prepared host. Then run `node load/sql-probes/519-unread-counts/frequency-host-check.ts > HOST_CHECK.json` as the measurement user on that idle host with the pinned image already available. Require exit 0 and `ok: true`. The check verifies host affinity before launch and after cleanup. It starts both containers, verifies their cpusets and queries PostgreSQL over the abstract socket. Its short `sudo -n` spawn uses the exact observer argv, requires the ready marker and a successful exit, and thus checks that systemd accepts `--slice=-.slice` for a transient scope. Record both checks with their output and exit statuses on #796. The checks are **not evidence**.

Every job calibrates the invariant TSC per CPU on the current boot. A raw-clock read bracket over 1 ms is unusable. F1 requires perf enabled and running deltas to match the CLOCK_MONOTONIC_RAW span (`rawNs`) within 1 ms. The helper also emits CLOCK_MONOTONIC (`monoNs`) for timing checks. A perf span may exceed the pgbench log span by at most 3 s, with the fixed 10 s tail added for the control only (100 ms tail timing allowance). The control compares its TSC rate and qualifying CPUs' APERF/MPERF ratios to turbostat's `TSC_MHz` and its raw APERF/MPERF deltas. The report flags a discrepancy over 2% for review.

## Run rules (maintainer decisions, 2026-11-21 and 2026-11-22, #769)

These rules stop invalid runs early and keep a failure from being paid for twice. Criteria, thresholds and VALID/INVALID rules never change under them.

- **Start:** any time of day, but only after the maintainer's go in chat. An approval of a run, a schedule or a deadline is not the go. One job at a time, on an idle host (no builds, AI workers or E2E).
- **Before the run:**
  - Plan review: before a new or changed harness is rehearsed, one AI review lists every way the run could end INVALID or NOT EVALUATED (for example statistics, caches, seed variance, sampling bias, host contention). Each item gets a preflight check, a fail-fast rule, or an accepted-risk line in the record.
  - Rehearsal: before asking for the go, run each queued job with `--rehearsal`, DIAGNOSTIC jobs included. It uses the recorded fixture size and runs setup end to end (build, migrations, seed, settle, readiness, headroom) with the recorded validity checks, then one short cell and the aggregation on that output. A rehearsal is never evidence. Fix every failure before asking for the go.
    - #426 seed diagnostic (#920): `node load/dms-formal-run.ts <config> --seed-diagnostic-rehearsal`, then `--seed-diagnostic-baseline-rehearsal`, then `node load/dms-formal-seed-effect.ts --rehearsal <instrumented> <baseline>`. Each arm runs its full arm's path (setup, seed, the same #798 collectors, the same collection checks, cleanup): both arms collect DB, Docker VM and host logs and validate seed timing; only the instrumented arm also streams DB logs and runs the kernel, PostgreSQL and host samplers on 1 Organization with 5 Message batches (125,000 Messages): about 2–5 minutes per arm on the Mac (estimate, not yet run). Every record carries `rehearsal: true` and the label `DIAGNOSTIC REHEARSAL`. The comparison's status is `rehearsal-compared`, never `compared`. Without `--rehearsal` the comparison refuses rehearsal arms, and it never mixes a rehearsal arm with a full arm. With one Organization the PR #685 stop rules cannot fire.
  - Disk capacity (#788, d3r `--backfill-only` and formal runs): within 60 minutes before the launch, run `node load/capacity/d3r.ts --stage=backfill-only|formal --out=OUT --rehearsal=DIR [--from-backfill=DIR] --report=FILE` and keep the report in the run's record. The launch may start only if the report says `CAPACITY OK` and its `out`, `backfill` (formal), `rehearsal` and `docker` (context, endpoint, daemon id, storage) equal what the launch uses. `STOP`, a refusal, or any mismatch blocks the run; changing the output or source location needs a new report.
  - Fail fast: the harness checks validity in setup and again after the first measured block (sample counts, required phases, trace loss), so an invalid run stops within minutes.
- **Failures:**
  - `outcome: setup-failure` means the run stopped before the first measured sample. It is not a result. If the cause is known and fixed, the job may rerun once in the same chain without a new go, logged in the chain log and the record.
  - `outcome: result-failure` means sampling had started. It is a result and never reruns in the same chain.
  - No blind rerun: after INVALID or NOT EVALUATED, nothing reruns until the cause is found and fixed and the fix passes a rehearsal. If the cause cannot be identified, the options go to the maintainer.
