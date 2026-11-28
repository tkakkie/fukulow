# Measurements

Keep each scenario's latest baseline, decision or open acceptance, harness, command and limits. Append superseded or detailed records verbatim to `load/measurements-archive.md`. [SQL rules](workflow.md#14-focused-sql-measurements) · [Writing rules](workflow.md#13-splitting-a-doc)

No performance, capacity or latency guarantee. Compare only matching send limits and publishing Member counts.

Raw logs, artifacts and paths outside Git may be gone. [Check](../load/measurements-archive.md#raw-data-check-2026-11-18) · [Archive](../load/measurements-archive.md) · [#442](../load/measurements-archive.md#moved-records-442-2026-11-15)

## Measurement hosts (#796)

- **Mac (M5):** development; #689, #519, #426 B7 and Mac-approved plans keep Mac conditions.
- **Ubuntu (Zen 5/Zen 5c):** formal, default for new series since #796 PASS, no Mac comparison or gate. AC, masked sleep, performance governor, held updates, HOST-BUSY, fixed CPU sets, pre/post records. Boost on except #796 cooling.
- **#796 PASS:** 3/3 formal runs valid at `2b441bd9`; spread TPS ≤ 0.68 % (limit 5 %), WAL/send ≤ 0.29 % (limit 2 %). [Full record](../load/measurements-archive.md#ubuntu-host-qualification-796-2026-11-25) · [Harness](../load/harness-core/README.md#796-frequency-validity-v3)
- Move series only with fresh Ubuntu baselines and criteria fixed first, never for Mac failures. First: #515.

## Topic projection paging (#137)

2026-11-11. Four response-paced readers, 50 items/page, concurrent sends every 50 ms. At 210,000 mixed Channel Messages, recent/deep p95 was 32.342/32.235 ms for reads and 11.249/6.345 ms for sends. A proportional projection put the prefix query's 100 ms read p95 at ~649k Messages.

Run `measure_topic_projection_pages` with `MEASURE_TOPICS=10000` against test PostgreSQL. Shared Mac, warm in-process HTTP, no TCP/proxy/TLS. [Command and record](../load/measurements-archive.md#137-round-1-mixed-timeline-and-concurrent-send-remeasurement-2026-11-11)

## Graceful shutdown and reconnect (#195)

2026-11-11 JST, PR #207 (before the send limiter, one publishing Member). The pinned 10,000-socket repeat resubscribed in 3,410 ms (461 ms Docker restart). Three 2,048-send probes drained in 777.360 / 813.652 / 804.816 ms. Evidence for [60 s drain and 75 s Compose grace](decisions/realtime.md#real-time-delivery) and [full jitter](decisions/web.md#web-client).

Reconnect uses `make load-record` (`load/record.ts`) and publishes after recovery. Drain uses `measure_sigterm_under_concurrent_sends` with isolated PostgreSQL 18.6. Native Mac drain releases COMMIT gates immediately and excludes deployed teardown. [Reconnect command and record](../load/measurements-archive.md#graceful-shutdown-and-reconnect-storm-195-2026-11-11-jst) · [Drain command and record](../load/measurements-archive.md#195-round-1-concurrent-send-sigterm-drain-2026-11-11-jst)

## Backup restore drill (#198 C)

2026-11-11 JST. Initial drill **1.82 seconds** on Apple M5 with cached PostgreSQL 18.6 and network-disabled tmpfs. The 133,556-byte dump held 2 Organizations, 2,000 Messages and 3 Sessions. [Procedure](spec/deployment.md#operations-backup-and-restore-198-c)

Commands: the procedure above, `scripts/backup.ts` then `scripts/restore-drill.ts`, in a separate Compose project. Excludes production disk/outage steps. [Full record](../load/measurements-archive.md#backup-restore-drill-198-c)

## Channel-list Unread ranges (#142)

2026-11-11 (review B1, `d1d5aaf`). Across 20 public Channels and 200 Topics at 1,000,000 Messages, before/after SQL p95 was 174.414 → 11.157 ms fully read and 255.727 → 14.202 ms with 2,000 unread. Evidence for [skipping read ranges](decisions/messages.md#topics-replies-and-unread-planned-spec-p1-p8).

Run `measure_unread_list_read_position_ranges` with disposable PostgreSQL 18.6 in `DATABASE_URL`. Warm sequential SQL, JIT at 1M, no HTTP or writers. [Command and record](../load/measurements-archive.md#channel-list-unread-read-position-ranges-142-review-b1-2026-11-11)

## Web Unread retained records (#272)

2026-11-12 JST (PR #273 round 1). One watched Channel, two Topics, 100,000 Messages and baseline refresh every 1,000. Retention disabled/enabled gave 100,000/1,000 peak records and 22,494,176/395,688 bytes final heap growth. Evidence for pruning under the [client rules](spec/realtime.md#topic-reply-and-unread-projections-owners-137-topics-server-138-topics-web-139-replies-server-140-replies-web-142-unread).

Run `web/src/unread-memory.test.ts` once per mode with `MEASURE_UNREAD=before` and `after`. Deterministic Node runs. Stale baselines, held aggregates and long visits widen retention. [Commands and record](../load/measurements-archive.md#web-unread-retained-records-272-2026-11-12-jst)

## RLS before and after (#314 step 5)

2026-11-13 JST, #343 (before the send limiter, one publishing Member). One-time [RLS performance exception](decisions/auth.md#auth-accounts-and-tenancy): eight-client history p95 0.335 → 0.389 ms (+16.1%) and replay +6.3% across eight runs per side. Modest send throughput and HTTP p95 changed 0.0%. #357 tracks a stable-host API rerun.

Compare `6dcadb7` and `a999a35` using `load/hot-plans/seed.sql` and `HOTPLANS_CONTAINER="$DB" LATENCY_CTX=1 LATENCY_CLIENTS=8 LATENCY_SECONDS=30 node load/hot-latency.ts`; sends use `make load-record`. Shared-host drift and explicit pgbench context transactions limit attribution. Supplemental runner was external. [Method](../load/measurements-archive.md#rls-beforeafter-314-step-5-2026-11-13-jst) · [Confirmation](../load/measurements-archive.md#mitigation-candidates-314-step-5) · [Decision](../load/measurements-archive.md#maintainer-decision-exception-to-the-10-criterion-314-step-5-2026-11-13)

## Sign-in admission (#196 C)

2026-11-13 JST. At 500 offered sign-ins/s for 60 s and 64 in flight at most, fixed `9677ca6` handled 30,000 sign-ins, returned 4,297 HTTP 503s and reached success p95 153 ms with 5 peak DB connections in use. Second-Organization reads were 120/120 per run at p95 ≤ 6.4 ms. Evidence for [admission before lookup](decisions/auth.md#auth-accounts-and-tenancy).

Run `make load-signin` (`load/signin.ts`) with `SERVER_REF=9677ca6`. Shared Mac, loopback. The base hit the in-flight cap. [Command and record](../load/measurements-archive.md#sign-in-admission-under-a-credential-flood-196-c-2026-11-13-jst)

## WebSocket caps and read buffer (#196 A)

2026-11-13 JST. For 10,000 idle subscribed sockets, 128 KiB versus 8 KiB gave RSS 2,693 / 2,693 versus 1,516 / 1,516 MiB. Eight reconnecting sockets for 30 s gave 12.1–13.8 subscribes/s with the budget and upgrade refusal versus 299–306 without limits. Evidence for [buffer size and refusal](decisions/realtime.md#admission-and-timeouts).

From `server/` with local PostgreSQL and `ulimit -n 100000`, run `measure_idle_socket_rss_by_read_buffer` and `measure_reconnect_flood_subscribe_load`. Loopback clients share the process and RSS. Cap confirmation is open in #431. [Commands and record](../load/measurements-archive.md#websocket-socket-caps-frame-budget-and-read-buffer-196-a-2026-11-13-jst)

## Light k6 run (#351)

2026-11-19, `223a948`, k6 2.4.0, the 2.x baseline; not comparable with 1.x. Eight publishing Members, burst 10, refill 1/s. Three interleaved Mac runs per version: same counts (80 sends, 400 deliveries, no errors/429s), delivery p95 16.00–17.05 ms. [Record and reproduction](../load/measurements-archive.md#light-k6-run-k6-182-vs-240-597-2026-11-19-jst-mac)

## Sustained write throughput (#309)

2026-11-13 JST, `6f95221` (before the send limiter). Four Members, 17-byte bodies, no subscribers. At 4,000 offered/s, 200 public Channels accepted 3,968/s at p95 21 ms and one hot Channel accepted 1,749/s at p95 68 ms. Evidence for the [write target](spec.md#performance-targets-first).

At `6f95221`, run `make load-throughput` (`load/throughput.ts`) for `many` and `hot`. One shared-host run per mode, no TLS/fan-out. k6 dropped iterations at the upper steps. [Commands and record](../load/measurements-archive.md#sustained-write-throughput-309-2026-11-13-jst)

## DM preliminary measurement (#151)

2026-11-14 JST. One Organization, 10,000 Members and 14,998 DMs on a shared Mac/VM. Quiet recovery drained 500/500 pending discoveries in 270.057 s over ten O5 runs. At 10,000 connections and 2,000 offered sends/s, at most 56.79% were accepted including drain. All sockets closed unexpectedly, with ACK p95/p99 of 814/1,045 ms.

Mac probe: `node load/dms-record.ts` with `DM_SOCKETS=10000`. For [formal acceptance](spec/dms.md#performance-acceptance-adopted-2026-11-14), use `node load/dms-formal-run.ts /absolute/private/formal.env`. #431 needs isolated Linux, full fixtures and storage/restore. [Result](../load/measurements-archive.md#direct-messages-preliminary-single-host-measurement-151-2026-11-14-jst-not-acceptance) · [Exact command](../load/measurements-archive.md#reproduction-and-dedicated-hardware-procedure)

## Invite list expiry range (#303)

2026-11-14 JST. At 1M expired and 260 live Invites, Owner first-page p95 fell 135.79 → 2.00 ms and Invite-create burst p95 429.17 → 4.78 ms. At 100k all-live, first-page p95 rose 1.69 → 41.19 ms. Supports the [expiry range and live sort](decisions/auth.md#auth-accounts-and-tenancy).

Run `node load/invite-scan.ts` (Node, Docker, sqlx CLI, Rust). Warm shared Mac, ordered variants, short bursts. [Full record](../load/measurements-archive.md#invite-list-expiry-range-and-organization-locking-303-2026-11-14-jst)

## Search engine and quality comparison (#153)

2026-11-18 JST, frozen v2 at `df13a2c` (#510, #518). At 1,000,000 Messages, 5 concurrent searches and 28 classes, P2 PGroonga passed the measured subset (worst p95 309.9 ms). pg_trgm and pg_bigm missed latency (2568.7 / 1154.9 ms). Micro F1 for split-query/kana-query/literal was 0.830 / 0.829 / 0.639.

Run `node load/search-engines/run.ts` and `node load/search-engines/quality/run.ts` at the frozen manifest. The [selection gate](decisions/process.md#rules-ci-and-ai-process) stays open for P2 security, DMs and deploy/restore. [Full record](../load/measurements-archive.md#search-engine-comparison-p2-definer-at-1m-153-2026-11-18-jst-mac)

## PGroonga Message-send write cost (#153 M1)

2026-11-20 JST at `31118ce`, Mac. **No material impact** in `many` or `hot` under #153 criteria. All three pairs sustained 50–250/s. Median A/B send p95 ratio ≤ 1.13 (+0.26 ms). At 250/s, WAL/send rose 26–29 %, DB growth ~2.5× and peak DB CPU ~1.8×. App CPU stayed flat. Limiter raised in both arms. F1 input only, outside #431. Search latency unmeasured. Adoption on hold. [Full record](../load/measurements-archive.md#pgroonga-message-send-write-cost-153-m1-2026-11-20-jst-mac)

Overnight on an idle Mac with Node 26.13.1 run `node load/search-m1.ts --out <new-absolute-dir>` and `node load/search-m1-report.ts <dir>`. Smoke mode is unjudged.

## d3r Message search (#689)

2026-11-24 JST, Mac, source `293c6d4f`, manifest `d096806e…`. **Formal PASS at 1M Messages**, worst p95 203.5 ms. Completeness, denials and RLS passed. A custom fixture dump restored to a clean database with matching checksums and verified grants, RLS and terms. Production search stays disabled. The rise in p95 across rounds is tracked under #870. [Formal record](https://github.com/tkakkie/fukulow/issues/689#issuecomment-7119457760)

At the pinned source, run `node load/search-engines/d3r/run.ts --from-backfill=<dir> --out=<new-dir>`.

## Channel log design evidence (#160)

2026-11-17 JST (PR #499). Settled Mac WAL at 250 ops/s, baseline/events-ids/log-ids: 5,190/5,197/5,434 B/op for create-1-17, 42,511/42,703/43,051 B/op for mixed90-200-4000. Run `load/log-compare/run.ts --diagnose --settle-fixture`. Both workloads at 50/250 ops/s include host-to-psql transport.

From the INVALID full run for the [Channel log decision](spec/realtime.md#measurement-status). A cold recent 50-entry deleted-range page at 1M positions used 235/34,126/209 shared buffers across baseline/events-ids/log-ids. At 1M Messages, log-ids cutover blocked for about 3.7 s (455 MiB WAL, +153 MiB storage). Run `load/log-compare/run.ts --full` at `1662d5d`. Timing spread exceeded the rule. [Full command](../load/measurements-archive.md#160-log-comparison-smoke-validation-2026-11-15) · [Settled WAL](../load/measurements-archive.md#160-log-comparison-wal-variance-diagnose-2026-11-17-jst) · [Replay and migration](../load/measurements-archive.md#160-log-comparison-replay-and-migration-reference-2026-11-17)

## Channel log send and replay (#515 slice 5)

Mac-relative, B `b975ffa` vs A `f7fe08a`, harness `df695bc`, separate from #431. Night 1 (2026-11-19 JST) Part A FAIL 4/4. Night 2 (2026-11-20) Part B max accepted/s (≥ 0.90) FAIL hot-17 0.878, many-17 0.885, hot-16000 0.865. PASS many-16000 0.923. Part C REST replay INVALID in all cells. A mostly completed 8–28/1,000 at p95 2.9–4.9 s vs B 1.5–2.0 ms (A regression under investigation). Part D (#137 timeline) `boundary=Some(190000)` PASS at 49.0 ms. `boundary=None` INVALID (B spread 10.8 %). [Record](../load/measurements-archive.md#channel-log-send-and-replay-515-slice-5-2026-11-19-to-2026-11-20-jst-mac)

Build, then run each night: `node load/slice5/run.ts --help`.

Mac diagnostics only. Night 3 stands (3 FAIL, 1 INVALID). Replay SQL (2026-11-22 JST) put A's page statement +0.38–0.53 ms p50 over B. App path (2026-11-23 JST) put A − B HTTP p50 at 0.48–0.58 ms, almost all in the component sum. [515-replay steps](../load/sql-probes/515-replay/README.md#run) · [515-app steps](../load/sql-probes/515-app/README.md#run) · [§14 record](https://github.com/tkakkie/fukulow/issues/515#issuecomment-7196020425) · [F1 archive](../load/measurements-archive.md#replay-page-generic-plan-515-f1-2026-11-23-jst-mac-diagnostic)

## Unread candidate bounds (#355)

2026-11-16 JST (PR #448). Against `1662d5d`, Auto execution fell 0.178 → 0.117 ms for visible list and 5.477 → 3.677 ms for counts. Evidence for [bounding the grant lookup and materializing Topic candidates](decisions/messages.md#topics-replies-and-unread-planned-spec-p1-p8).

Use `load/hot-plans/seed.sql` and `EXPLAIN (ANALYZE, BUFFERS)` on the before/after prepared SQL as `fukulow_app`, with JIT off in a read-only repeatable-read transaction. Warm shared Mac, overlapping medians, no accepted Mentions or sends. [Full record](../load/measurements-archive.md#unread-candidate-bounds-355-2026-11-16-jst)

## Unread counts probe (#519 A3, Mac, diagnostic)

2026-11-23 JST. Stop rule only (no gate). Step 1 read p95 (current → final, ms) was 5.701 → 2.104 at cut 75, 9.155 → 2.439 at 150, 18.453 → 2.818 at 575 and 58.435 → 5.130 at 2150. Sends STOP. Median tps ratios were 0.898 send-only and 0.806 with the #820 UPDATE-first migration (limit 0.90). Median WAL/send ratios were 1.190 and 1.125 (limit 1.20). [Harness steps](../load/sql-probes/519-unread-counts/README.md#10-step-1-final-design-finalts) · [§14 record](https://github.com/tkakkie/fukulow/issues/519#issuecomment-7196020998) · [Ubuntu continuation](https://github.com/tkakkie/fukulow/issues/519#issuecomment-7117805873)

## Bounded fan-out candidates (#354)

2026-11-16 JST. Against `1662d5d`, forced Generic `access_rows` at 1,000 candidates fell 296.334 → 2.561 ms and `member_access` at 1,024 fell 84.613 → 1.981 ms, with more shared hits. Evidence for [bounding fan-out](decisions/realtime.md#real-time-delivery).

Run `node load/hot-plans/fanout.ts <container> <database> <out>` on `load/hot-plans/seed.sql`. Warm Mac, no DMs or sends. Measured three five-pass rounds. Current harness takes 15 passes. [Full record](../load/measurements-archive.md#bounded-fan-out-candidates-354-2026-11-16-jst)

## Rust/wasm sync core (#466, #487)

2026-11-21. [Rust/wasm default](decisions/web.md#web-client) accepted despite throttled cold `/` Timeline p95 +16% (#466, `d2fc5ea`). #487 (`c02e1a78`, 5 rounds): `step()` p95 426 → 346 µs, 100 msg/s p95 1.94 → 1.70 ms, 18.19 → 18.35 MiB. Bulk INCONCLUSIVE, slope HOLD (#489). #954 preload (#962) MISSED, early list (#978) MET ([records](../load/measurements-archive.md#wasm-preload-954-2026-11-25)). #488 Map `ff681721` `step()` p50 +20.7% MISSED. Fix `3482ee02` (5 rounds) met all gates, `step()` p50 +1.0%, bulk −6 to −17%, slope HOLD as B ([record](../load/measurements-archive.md#wasm-merge-map-488-2026-11-27-mac)).

Run `FIRST_PAINT_IMAGE=fukulow-466:<arm> FIRST_PAINT_RUNS=5 node web/scripts/first-paint.ts`; `node --expose-gc web/scripts/measure-wasm-core.ts --core wasm --arm B|W --out <dir> --round <n>`, then `--aggregate`. Mac, Node 26.13.1. [Record](../load/measurements-archive.md#rustwasm-sync-core-typed-deltas-487-2026-11-21-jst-mac)

#1128 release Wasm (`a878e090`): 558,619 B raw, 161,082 B gzip (level 6). macOS 27.0.1 arm64 (M5), Rust 1.100.0, wasm-bindgen 0.2.130, Node 26.13.1. From root run `(cd web && node ../scripts/build-wasm.ts)` then `node scripts/check-wasm-budget.ts web/wasm`. CI reuses `npm --prefix web run build` on `ubuntu-latest` and skips the PR delta to avoid a second build.

## Pool before and after PR #511 (#196 B)

2026-11-17 JST, `956f91e` vs `fa1790b`. Three Mac pairs, 200 public Channels, 4,000 Members, burst 10 and refill 1/s, 60 s steps, no subscribers. Send-only 250 and 500/s failed latency with 100% accepted. At 250/s pair 2 p95/p99 was 2.11/3.70 → 12.13/18.71 ms. Higher send steps and mixed steps were NOT EVALUATED. Follow-up to the [pool timeout decision](decisions/realtime.md#admission-and-timeouts). Cause investigation in #519.

Run `node load/pool-before-after.ts --out <dir>` at `ee36849` with the external two-edit patch. Whole diff, no per-request pool-timeout attribution. [Method](../load/measurements-archive.md#196-b-beforeafter-method) · [Full record](../load/measurements-archive.md#196-b-beforeafter-after-pr-511-results-2026-11-17-jst-mac)

## Authoritative Reply count HTTP latency (#409)

2026-11-18 JST, run 4 at `d3a9b28`. Open-loop HTTP with RLS, 16 requests per 100 ms, three repeats per shape with 10,000 successes each. Scheduled-start p95 was 27.508–28.282 ms for normal batches and 29.456–30.185 / 33.788–34.142 ms with 10,000/100,000-Reply chains. All met the [Reply count](spec/realtime.md#topic-reply-and-unread-projections-owners-137-topics-server-138-topics-web-139-replies-server-140-replies-web-142-unread) gate.

Run `load/reply-counts-run.ts --formal`. Warm loopback on shared Mac, no writes, subscribers or proxy/TLS. [Command and record](../load/measurements-archive.md#reply-count-http-p95-verification-409-2026-11-18-jst)

## Revocation hold retry bursts (#592)

2026-11-21 JST, `2bad2c7d`, send time (#622): `recheck` 4,096 ×3 PASS, 24/24 sends matched each, 0 in fault. 2026-11-20 4096 FAIL kept. Maintainer: backoff acceptable (≤ 4 holds; high counts: #668), no jitter.

Run `node load/revocation-burst.ts --out <dir>`. [Record](../load/measurements-archive.md#revocation-hold-send-time-rerun-592-2026-11-21-jst-mac)

## Sign-in burst owner impact (#756, #359)

2026-11-23 JST, server `b4796346`, harness `4e4b4b8b`: **aggregate PASS** (A0, B1–B5, C1, C2 ×3). One IP, 16 wrong passwords at 3 window opens: 5×401 each, 3 waiters on X's row (4 once, within 1 ms log stamps), waits 12.6–60.8 ms. Owner password change/revoke-others 39/39 204, ≤ 105.3 ms (C2 bound ≥ 205.9). 90/91 B1 owner sign-ins 429 (#757). Limits: no multi-IP attack, one Mac, 3 runs, clock ≤ ±1.52 ms, 10 ms `deadlock_timeout` logging; rehearsal B4 miss is no evidence.

Run `node load/signin-owner-burst.ts --recorded` ×3 and its `-aggregate.ts`. [Record](../load/measurements-archive.md#sign-in-burst-owner-impact-756-359-2026-11-23-jst-mac)

## Readiness connection setup (#1066)

2026-11-26 Ubuntu, `b730f181`: 1,000 empty-pool acquisitions per state (TCP+SCRAM+startup). p50/p99.9/max 3.04/4.69/5.34 ms idle, 3.16/4.75/4.82 ms under #351 light load: option 3 ([accepted limit](decisions/process.md#product-stack-and-delivery)). VPS: #431.

Run `load/conn-setup/queue.ts`, then `load/launch.ts`. [Record](../load/measurements-archive.md#readiness-connection-setup-1066-2026-11-26-ubuntu)

## Archived only

- [`make load` and `load/record.ts` methods](../load/measurements-archive.md#load-harness-methods-20-57) · [Load decisions](decisions/load.md#load-testing-and-measurement)
- Mixed paging supersedes [Topic-only paging](../load/measurements-archive.md#topic-projection-paging-feasibility-137-2026-11-11).
- #519 A3 supersedes [Unread Topic-count index bound under RLS (#356)](../load/measurements-archive.md#unread-topic-count-seq-index-bound-under-rls-356-2026-11-17-jst). Guard `unread_list_counts_never_read_messages_in_any_plan_mode`.
- [DM Q4 offered work and overhead](../load/measurements-archive.md#dm-q4-concurrent-offered-work-evidence-151-2026-11-15) (procedure, `load/dms-formal-run.ts`).
- [DM instrumentation-overhead](../load/measurements-archive.md#426-mac-relative-instrumentation-overhead-attempts-not-evaluated-2026-11-16-jst) (NOT EVALUATED, build/setup failures).
- Channel log [functional smoke](../load/measurements-archive.md#160-log-comparison-smoke-validation-2026-11-15) and [full run](../load/measurements-archive.md#160-log-comparison-full-run-invalid-2026-11-16-jst) (INVALID).
- [Proxy comparison](../load/measurements-archive.md#proxy-comparison-harness-469-part-3--results-pending) (pending).
- Startup fix supersedes [earlier wasm first display](../load/measurements-archive.md#first-display-345-conditions-re-measured-at-d2fc5ea-45-runscell-across-9-interleaved-rounds-median-of-round-p50--p95-ms).
- Post-#511 comparison supersedes [pool PR #388](../load/measurements-archive.md#196-b-beforeafter-results-2026-11-17-jst-mac).
- HTTP and SQL evidence supersede [Reply count SQL-only probe](../load/measurements-archive.md#authoritative-reply-count-sql-plans-409-2026-11-17).
- [Reply count HTTP runs 1–3 and pilots](../load/measurements-archive.md#reply-count-http-p95-verification-409-2026-11-18-jst) (NOT EVALUATED, superseded or pilot only).
- [Watermark investigation](../load/measurements-archive.md#watermark-subscription-admission-investigation-478-2026-11-17-jst) supports [admission policy](decisions/realtime.md#admission-and-timeouts).
- [Precompressed web assets](../load/measurements-archive.md#precompressed-web-asset-transfer-486-2026-11-17-jst) cut Wasm 131,573 → 103,813 B with [Brotli sidecars](decisions/auth.md#auth-accounts-and-tenancy).
