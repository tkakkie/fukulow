# Measurements

Keep only the latest baseline per scenario, the decision or open acceptance it supports, the harness path and reproduction command ([focused SQL rules](workflow.md#14-focused-sql-measurements)), and known limits. Append superseded or new detailed records verbatim to `load/measurements-archive.md` and summarise the current evidence here. [Writing rules](workflow.md#13-splitting-a-doc)

Measurements are evidence only and establish no performance, capacity or latency guarantee.
Compare runs only at the same send-limit settings and publishing Member count.

Raw logs, artifact directories and local paths outside Git may be gone ([2026-11-18 check](../load/measurements-archive.md#raw-data-check-2026-11-18)). See the [archive](../load/measurements-archive.md), including [#442 pointers](../load/measurements-archive.md#moved-records-442-2026-11-15).

## Measurement hosts (#796)

- **Mac (M5):** formal today. #689, #519 and #426 B7 keep their Mac conditions and results.
- **Ubuntu (Zen 5/Zen 5c):** investigation only until #796 PASS. No Mac comparison or gate. After PASS, Ubuntu is formal and Mac is for development.
- **Ubuntu conditions:** AC, sleep masked, performance governor, updates held, HOST-BUSY, fixed even/odd CPU sets and before/after host records. Boost on except for #796 cooling.
- **#796:** first FAIL stands. V3 uses hardware counters. Control and Rehearsal 2 need separate goes. Go B STOPs pending review and frozen floors. [Harness](../load/harness-core/README.md#796-frequency-validity-v3)
- Move a series only with a new Ubuntu baseline and fixed criteria, never for a bad Mac result.

## Topic projection paging (#137)

2026-11-11. Four response-paced readers, 50 items/page, concurrent sends every 50 ms. At 210,000 mixed Channel Messages, recent/deep p95 was 32.342/32.235 ms for reads and 11.249/6.345 ms for sends. A proportional projection put the prefix query's 100 ms read p95 at ~649k Messages.

Run `MEASURE_TOPICS=10000 cargo test --release -p fukulow-server --lib measure_topic_projection_pages -- --ignored --nocapture` against test PostgreSQL. Shared Mac, warm in-process HTTP, no TCP/proxy/TLS. [Full record](../load/measurements-archive.md#137-round-1-mixed-timeline-and-concurrent-send-remeasurement-2026-11-11)

## Graceful shutdown and reconnect (#195)

2026-11-11 JST, PR #207 (before the send limiter, one publishing Member). The pinned 10,000-socket repeat resubscribed in 3,410 ms (461 ms Docker restart). Three 2,048-send probes drained in 777.360 / 813.652 / 804.816 ms. Evidence for [60 s drain and 75 s Compose grace](decisions/realtime.md#real-time-delivery) and [full jitter](decisions/web.md#web-client).

Run `LOAD_RECONNECT_STORM=1 LOAD_DIRECT_NETWORK=1 CHANNELS=1 SUBSCRIBERS=10000 SOCKETS_PER_SESSION=500 CONNECT_BATCH=100 CONNECT_INTERVAL_MS=100 PUBLISHERS=1 DURATION_SECONDS=3 PUBLISH_INTERVAL_MS=500 READY_TIMEOUT_SECONDS=120 DRAIN_TIMEOUT_SECONDS=30 make load-record` (`load/record.ts`) and `cargo test --release -p fukulow-server --lib measure_sigterm_under_concurrent_sends -- --ignored --nocapture` with isolated PostgreSQL 18.6. Storm publishes after recovery. Native Mac drain releases COMMIT gates immediately and excludes deployed teardown. [Reconnect record](../load/measurements-archive.md#graceful-shutdown-and-reconnect-storm-195-2026-11-11-jst) · [Drain record](../load/measurements-archive.md#195-round-1-concurrent-send-sigterm-drain-2026-11-11-jst)

## Backup restore drill (#198 C)

2026-11-11 JST. Initial drill **1.82 seconds** with a cached PostgreSQL 18.6 image and network-disabled tmpfs on Apple M5. The 133,556-byte dump held 2 Organizations, 2,000 Messages and 3 Sessions. Evidence for the [backup and restore procedure](spec/deployment.md#operations-backup-and-restore-198-c).

In a separate source Compose project, run `node scripts/backup.ts /absolute/private/backup-directory`, then `node scripts/restore-drill.ts /absolute/private/backup-directory/fukulow-EXAMPLE.dump` with the actual dump. Excludes production disk/outage steps. [Full record](../load/measurements-archive.md#backup-restore-drill-198-c)

## Channel-list Unread ranges (#142)

2026-11-11 (review B1, `d1d5aaf`). Across 20 public Channels and 200 Topics at 1,000,000 Messages, before/after SQL p95 was 174.414 → 11.157 ms fully read and 255.727 → 14.202 ms with 2,000 unread. Evidence for [skipping read ranges](decisions/messages.md#topics-replies-and-unread-planned-spec-p1-p8).

With disposable PostgreSQL 18.6 in `DATABASE_URL`, run `cargo test --release -p fukulow-server --lib measure_unread_list_read_position_ranges -- --ignored --nocapture`. Warm sequential SQL, JIT at 1M, no HTTP or writers. [Full record](../load/measurements-archive.md#channel-list-unread-read-position-ranges-142-review-b1-2026-11-11)

## Web Unread retained records (#272)

2026-11-12 JST (PR #273 round 1). One watched Channel, two Topics, 100,000 Messages and baseline refresh every 1,000. Retention disabled/enabled gave 100,000/1,000 peak records and 22,494,176/395,688 bytes final heap growth. Evidence for pruning under the [client rules](spec/realtime.md#topic-reply-and-unread-projections-owners-137-topics-server-138-topics-web-139-replies-server-140-replies-web-142-unread).

Run `MEASURE_UNREAD=before npm --prefix web test -- src/unread-memory.test.ts --execArgv=--expose-gc --reporter=verbose --disableConsoleIntercept`, then repeat with `MEASURE_UNREAD=after`. One deterministic Node run per mode. Stale baselines, held aggregates and long visits widen retention. [Full record](../load/measurements-archive.md#web-unread-retained-records-272-2026-11-12-jst)

## RLS before and after (#314 step 5)

2026-11-13 JST, #343 (before the send limiter, one publishing Member). One-time [RLS performance exception](decisions/auth.md#auth-accounts-and-tenancy): eight-client history p95 0.335 → 0.389 ms (+16.1%) and replay +6.3% across eight runs per side. Modest send throughput and HTTP p95 changed 0.0%. #357 tracks a stable-host API rerun.

Compare `6dcadb7` and `a999a35` using `load/hot-plans/seed.sql` and `HOTPLANS_CONTAINER="$DB" LATENCY_CTX=1 LATENCY_CLIENTS=8 LATENCY_SECONDS=30 node load/hot-latency.ts`; sends use `make load-record`. Shared-host drift and explicit pgbench context transactions limit attribution. Supplemental runner was external. [Method](../load/measurements-archive.md#rls-beforeafter-314-step-5-2026-11-13-jst) · [Confirmation](../load/measurements-archive.md#mitigation-candidates-314-step-5) · [Decision](../load/measurements-archive.md#maintainer-decision-exception-to-the-10-criterion-314-step-5-2026-11-13)

## Sign-in admission (#196 C)

2026-11-13 JST. At 500 offered sign-ins/s for 60 s and 64 in flight at most, fixed `9677ca6` handled 30,000 sign-ins, returned 4,297 HTTP 503s and reached success p95 153 ms with 5 peak DB connections in use. Second-Organization reads were 120/120 per run at p95 ≤ 6.4 ms. Evidence for [admission before lookup](decisions/auth.md#auth-accounts-and-tenancy).

Run `LOAD_PORT=18096 SIGNIN_CONCURRENCY=64 SIGNIN_RATE=500 SIGNIN_SECONDS=60 SIGNIN_READ_RATE=2 SIGNIN_ACCOUNTS=1000 SIGNIN_IP_POOL=10000 SIGNIN_CORRECT_EVERY=10 SIGNIN_TIMEOUT_SECONDS=45 SERVER_REF=9677ca6 make load-signin` (`load/signin.ts`). Shared Mac, loopback. The base hit the in-flight cap. [Full record](../load/measurements-archive.md#sign-in-admission-under-a-credential-flood-196-c-2026-11-13-jst)

## WebSocket caps and read buffer (#196 A)

2026-11-13 JST. For 10,000 idle subscribed sockets, 128 KiB versus 8 KiB gave RSS 2,693 / 2,693 versus 1,516 / 1,516 MiB. Eight reconnecting sockets for 30 s gave 12.1–13.8 subscribes/s with the budget and upgrade refusal versus 299–306 without limits. Evidence for [buffer size and refusal](decisions/realtime.md#admission-and-timeouts).

From `server/` with local PostgreSQL and `ulimit -n 100000`, run `MEASURE_READ_BUFFER=8192 cargo test --release --lib realtime::tests::limits::measure_idle_socket_rss_by_read_buffer -- --ignored --exact --nocapture` and `MEASURE_SECONDS=30 MEASURE_FLOODERS=8 cargo test --release --lib realtime::tests::limits::measure_reconnect_flood_subscribe_load -- --ignored --exact --nocapture`. Loopback clients share the process and RSS. Cap confirmation is open in #431. [Full record](../load/measurements-archive.md#websocket-socket-caps-frame-budget-and-read-buffer-196-a-2026-11-13-jst)

## Light k6 run (#351)

2026-11-19, `223a948`, k6 2.4.0, the 2.x baseline; not comparable with 1.x. Eight publishing Members, burst 10, refill 1/s. Three interleaved Mac runs per version: same counts (80 sends, 400 deliveries, no errors/429s), delivery p95 16.00–17.05 ms. [Record and reproduction](../load/measurements-archive.md#light-k6-run-k6-182-vs-240-597-2026-11-19-jst-mac)

## Sustained write throughput (#309)

2026-11-13 JST, `6f95221` (before the send limiter). Four Members, 17-byte bodies, no subscribers. At 4,000 offered/s, 200 public Channels accepted 3,968/s at p95 21 ms and one hot Channel accepted 1,749/s at p95 68 ms. Evidence for the [write target](spec.md#performance-targets-first).

At `6f95221`, run `THROUGHPUT_SCENARIO=many THROUGHPUT_RATES=50,100,250,500,1000,2000,4000 THROUGHPUT_STEP_SECONDS=60 THROUGHPUT_VUS=20 THROUGHPUT_MAX_VUS=100 REQUEST_TIMEOUT_SECONDS=3 make load-throughput` (`load/throughput.ts`), then repeat with `THROUGHPUT_SCENARIO=hot`. One shared-host run per mode, no TLS/fan-out. k6 dropped iterations at the upper steps. [Full record](../load/measurements-archive.md#sustained-write-throughput-309-2026-11-13-jst)

## DM preliminary measurement (#151)

2026-11-14 JST. One Organization, 10,000 Members and 14,998 DMs on a shared Mac/VM. Quiet recovery drained 500/500 pending discoveries in 270.057 s over ten O5 runs. At 10,000 connections and 2,000 offered sends/s, at most 56.79% were accepted including drain. All sockets closed unexpectedly, with ACK p95/p99 of 814/1,045 ms.

Mac probe: `node load/dms-record.ts` with `DM_SOCKETS=10000`. For [formal acceptance](spec/dms.md#performance-acceptance-adopted-2026-11-14), use `node load/dms-formal-run.ts /absolute/private/formal.env`. #431 needs isolated Linux, full fixtures and storage/restore. [Result](../load/measurements-archive.md#direct-messages-preliminary-single-host-measurement-151-2026-11-14-jst-not-acceptance) · [Exact command](../load/measurements-archive.md#reproduction-and-dedicated-hardware-procedure)

## Invite list expiry range (#303)

2026-11-14 JST. At 1M expired and 260 live Invites, Owner first-page p95 fell 135.79 → 2.00 ms and Invite-create burst p95 429.17 → 4.78 ms. At 100k all-live, first-page p95 rose 1.69 → 41.19 ms. Supports the [expiry range and live sort](decisions/auth.md#auth-accounts-and-tenancy).

Run `node load/invite-scan.ts` (Node, Docker, sqlx CLI, Rust). Warm shared Mac, ordered variants, short bursts. [Full record](../load/measurements-archive.md#invite-list-expiry-range-and-organization-locking-303-2026-11-14-jst)

## Search engine and quality comparison (#153)

2026-11-18 JST, frozen v2 at `df13a2c` (#510, #518). At 1,000,000 Messages, 5 concurrent searches and 28 classes, P2 PGroonga passed the measured subset (worst class p95 309.9 ms). pg_trgm and pg_bigm missed latency at 2568.7 and 1154.9 ms. Quality micro F1 was 0.830 for split-query, 0.829 for kana-query and 0.639 for literal modes.

Run `node load/search-engines/run.ts`, then `node load/search-engines/quality/run.ts` at the frozen manifest. The [selection gate](decisions/process.md#rules-ci-and-ai-process) stays open for P2 security, DMs and deploy/restore. [Full record](../load/measurements-archive.md#search-engine-comparison-p2-definer-at-1m-153-2026-11-18-jst-mac)

## PGroonga Message-send write cost (#153 M1)

2026-11-20 JST at `31118ce`, Mac. **No material impact** in `many` and `hot` under the fixed #153 criteria: B sustained 50–250/s in all three pairs, A sustained each of those steps, and the median A/B send p95 ratio was at most 1.13 (+0.26 ms). Recorded only, at 250/s: WAL/send +26–29 %, DB growth ~2.5×, DB CPU peak ~1.8×, app CPU unchanged. Input for F1 only; PGroonga adoption stays on hold. Limiter raised in both arms; search latency not measured; outside #431. [Method and result](../load/measurements-archive.md#pgroonga-message-send-write-cost-153-m1-2026-11-20-jst-mac)

Run overnight on an otherwise idle Mac with Node 26.13.1: `node load/search-m1.ts --out /absolute/new/artifact-directory` (`--smoke`: B, `many`, 50/s for 10 s, never judged); regenerate with `node load/search-m1-report.ts /absolute/new/artifact-directory`.

## Channel log design evidence (#160)

2026-11-17 JST (PR #499). Settled Mac WAL at 250 ops/s, baseline/events-ids/log-ids: 5,190/5,197/5,434 B/op for create-1-17 and 42,511/42,703/43,051 B/op for mixed90-200-4000. Run `node load/log-compare/run.ts --diagnose --out <dir> --settle-fixture`. Two workloads at 50/250 ops/s, host-to-psql transport included.

Reference for the [Channel log decision](spec/realtime.md#measurement-status), from the INVALID full run. A cold recent 50-entry deleted-range page at 1M positions used 235/34,126/209 shared buffers across baseline/events-ids/log-ids. At 1M Messages, log-ids cutover blocked for about 3.7 s (455 MiB WAL, +153 MiB storage). Command at `1662d5d`: `node load/log-compare/run.ts --full --out <dir> --rates 50,250,1000 --seconds 30 --max-seconds 15 --clients 16 --rounds 3`. Timing spread exceeded the rule. [Settled WAL](../load/measurements-archive.md#160-log-comparison-wal-variance-diagnose-2026-11-17-jst) · [Replay and migration](../load/measurements-archive.md#160-log-comparison-replay-and-migration-reference-2026-11-17)

## Channel log send and replay (#515 slice 5)

Mac-relative, B `b975ffa` vs A `f7fe08a`, harness `df695bc`; separate from #431. Night 1 (2026-11-19 JST) Part A: FAIL in all 4 cells. Night 2 (2026-11-20) Part B max accepted/s (≥ 0.90): FAIL hot-17 0.878, many-17 0.885, hot-16000 0.865; PASS many-16000 0.923. Part C REST replay: INVALID in all cells; A mostly completed 8–28 of 1,000 requests at p95 2.9–4.9 s vs B 1.5–2.0 ms (candidate-only regression under investigation). Part D (#137 timeline): `boundary=Some(190000)` PASS at 49.0 ms; `boundary=None` INVALID (B spread 10.8 %). [Record](../load/measurements-archive.md#channel-log-send-and-replay-515-slice-5-2026-11-19-to-2026-11-20-jst-mac)

Build, then run each night: `node load/slice5/run.ts --help`.

## Unread candidate bounds (#355)

2026-11-16 JST (PR #448). Against `1662d5d`, Auto execution fell 0.178 → 0.117 ms for visible list and 5.477 → 3.677 ms for counts. Evidence for [bounding the grant lookup and materializing Topic candidates](decisions/messages.md#topics-replies-and-unread-planned-spec-p1-p8).

Use `load/hot-plans/seed.sql` and `EXPLAIN (ANALYZE, BUFFERS)` on the before/after prepared SQL as `fukulow_app`, with JIT off in a read-only repeatable-read transaction. Warm shared Mac, overlapping medians, no accepted Mentions or sends. [Full record](../load/measurements-archive.md#unread-candidate-bounds-355-2026-11-16-jst)

## Bounded fan-out candidates (#354)

2026-11-16 JST. Against `1662d5d`, forced Generic `access_rows` at 1,000 candidates fell 296.334 → 2.561 ms and `member_access` at 1,024 fell 84.613 → 1.981 ms, with more shared hits. Evidence for [bounding fan-out](decisions/realtime.md#real-time-delivery).

Run `node load/hot-plans/fanout.ts <container> <database> <out>` on `load/hot-plans/seed.sql`. Warm Mac, no DMs or sends. Measured three five-pass rounds. Current harness takes 15 passes. [Full record](../load/measurements-archive.md#bounded-fan-out-candidates-354-2026-11-16-jst)

## Rust/wasm sync core (#466, #487)

2026-11-21 JST. [Rust/wasm default](decisions/web.md#web-client) accepted with misses (#466; at `d2fc5ea`, throttled cold `/` Timeline p95 2806.7 → 3260.3 ms, FCP 960.0 ms both). #487 `06264eab` → `c02e1a78`, 5 rounds: `step()` p95 426 → 346 µs, 100 msg/s p95 1.94 → 1.70 ms, steady 18.19 → 18.35 MiB. Open, not passed: bulk INCONCLUSIVE, slope HOLD (#489).

Run `FIRST_PAINT_IMAGE=fukulow-466:<arm> FIRST_PAINT_RUNS=5 node web/scripts/first-paint.ts`; `node --expose-gc web/scripts/measure-wasm-core.ts --core wasm --arm B|W --out <dir> --round <n>`, then `--aggregate`. Mac, Node 26.13.1. [Record](../load/measurements-archive.md#rustwasm-sync-core-typed-deltas-487-2026-11-21-jst-mac)

## Pool before and after PR #511 (#196 B)

2026-11-17 JST, `956f91e` vs `fa1790b`. Three Mac pairs, 200 public Channels, 4,000 Members, burst 10 and refill 1/s, 60 s steps, no subscribers. Send-only 250 and 500/s failed latency with 100% accepted. At 250/s pair 2 p95/p99 was 2.11/3.70 → 12.13/18.71 ms. Higher send steps and mixed steps were NOT EVALUATED. Follow-up to the [pool timeout decision](decisions/realtime.md#admission-and-timeouts). Cause investigation in #519.

Run `node load/pool-before-after.ts --out <dir>` at `ee36849` with the external two-edit patch. Whole diff, no per-request pool-timeout attribution. [Method](../load/measurements-archive.md#196-b-beforeafter-method) · [Full record](../load/measurements-archive.md#196-b-beforeafter-after-pr-511-results-2026-11-17-jst-mac)

## Authoritative Reply count HTTP latency (#409)

2026-11-18 JST, run 4 at `d3a9b28`. Open-loop HTTP with RLS, 16 requests per 100 ms, three repeats per shape with 10,000 successes each. Scheduled-start p95 was 27.508–28.282 ms for normal batches and 29.456–30.185 / 33.788–34.142 ms with 10,000/100,000-Reply chains. All met the [Reply count](spec/realtime.md#topic-reply-and-unread-projections-owners-137-topics-server-138-topics-web-139-replies-server-140-replies-web-142-unread) gate.

Run `mise exec node@26.13.1 -- node load/reply-counts-run.ts --formal --out <dir>`. Warm loopback on shared Mac, no writes, subscribers or proxy/TLS. [Full record](../load/measurements-archive.md#reply-count-http-p95-verification-409-2026-11-18-jst)

## Revocation hold retry bursts (#592)

2026-11-21 JST, `2bad2c7d`, send time (#622): `recheck` 4,096 ×3 PASS, 24/24 sends matched each, 0 in fault. 2026-11-20 4096 FAIL kept. Maintainer: backoff acceptable (≤ 4 holds; high counts: #668), no jitter.

Run `node load/revocation-burst.ts --out <dir>`. [Record](../load/measurements-archive.md#revocation-hold-send-time-rerun-592-2026-11-21-jst-mac)

## Sign-in burst owner impact (#756, #359)

2026-11-23 JST, server `b4796346`, harness `4e4b4b8b`: **aggregate PASS** (A0, B1–B5, C1, C2 ×3). One IP, 16 wrong passwords at 3 window opens: 5×401 each, 3 waiters on X's row (4 once, within 1 ms log stamps), waits 12.6–60.8 ms. Owner password change/revoke-others 39/39 204, ≤ 105.3 ms (C2 bound ≥ 205.9). 90/91 B1 owner sign-ins 429 (#757). Limits: no multi-IP attack, one Mac, 3 runs, clock ≤ ±1.52 ms, 10 ms `deadlock_timeout` logging; rehearsal B4 miss is no evidence.

Run `node load/signin-owner-burst.ts --recorded` ×3 and its `-aggregate.ts`. [Record](../load/measurements-archive.md#sign-in-burst-owner-impact-756-359-2026-11-23-jst-mac)

## Archived only

- [Load harness methods](../load/measurements-archive.md#load-harness-methods-20-57) — procedures for `make load` and `load/record.ts`. [Load decisions](decisions/load.md#load-testing-and-measurement)
- [Topic-only paging](../load/measurements-archive.md#topic-projection-paging-feasibility-137-2026-11-11) — superseded by the mixed paging run.
- Search preliminary [engine](../load/measurements-archive.md#search-engine-comparison-153-2026-11-15-jst-preliminary-mac) and [quality](../load/measurements-archive.md#search-quality-comparison-153-2026-11-15-jst) comparisons — superseded by frozen-manifest runs (quality scores reproduced).
- [Search evaluation freeze and lifecycle](../load/measurements-archive.md#search-evaluation-freeze-and-lifecycle-procedure-153-2026-11-15-jst) — procedure and smoke validation only.
- [Unread Topic-count index bound under RLS (#356)](../load/measurements-archive.md#unread-topic-count-seq-index-bound-under-rls-356-2026-11-17-jst) — superseded by #519 A3 (guard `unread_list_counts_never_read_messages_in_any_plan_mode`).
- [Replay page generic plan (#515 F1)](../load/measurements-archive.md#replay-page-generic-plan-515-f1-2026-11-23-jst-mac-diagnostic) — diagnostic only, not evidence; #515 stays FAIL.
- [Search frozen v1](../load/measurements-archive.md#search-engine-comparison-frozen-manifest-v1-153-2026-11-17-jst-mac) — superseded for the selection gate by P2.
- [DM Q4 offered work and overhead procedure](../load/measurements-archive.md#dm-q4-concurrent-offered-work-evidence-151-2026-11-15) — procedure only. See `load/dms-formal-run.ts`.
- [DM instrumentation-overhead attempts](../load/measurements-archive.md#426-mac-relative-instrumentation-overhead-attempts-not-evaluated-2026-11-16-jst) — NOT EVALUATED after build and setup failures.
- Channel log [smoke](../load/measurements-archive.md#160-log-comparison-smoke-validation-2026-11-15) (functional only) and [full run](../load/measurements-archive.md#160-log-comparison-full-run-invalid-2026-11-16-jst) (INVALID for the gate).
- [Proxy comparison](../load/measurements-archive.md#proxy-comparison-harness-469-part-3--results-pending) — results pending.
- [Earlier wasm first display](../load/measurements-archive.md#first-display-345-conditions-re-measured-at-d2fc5ea-45-runscell-across-9-interleaved-rounds-median-of-round-p50--p95-ms) — superseded by the startup fix.
- [Pool before and after PR #388](../load/measurements-archive.md#196-b-beforeafter-results-2026-11-17-jst-mac) — superseded by the post-PR #511 comparison.
- [Reply count SQL-only probe](../load/measurements-archive.md#authoritative-reply-count-sql-plans-409-2026-11-17) — superseded by HTTP and SQL evidence.
- [Reply count HTTP runs 1–3 and pilots](../load/measurements-archive.md#reply-count-http-p95-verification-409-2026-11-18-jst) — NOT EVALUATED, superseded or pilot only; reasons in the record.
- [Watermark subscription admission](../load/measurements-archive.md#watermark-subscription-admission-investigation-478-2026-11-17-jst) — investigation evidence for the [admission policy](decisions/realtime.md#admission-and-timeouts).
- [Precompressed web assets](../load/measurements-archive.md#precompressed-web-asset-transfer-486-2026-11-17-jst) — wasm 131,573 → 103,813 bytes, evidence for [Brotli sidecars](decisions/auth.md#auth-accounts-and-tenancy).
