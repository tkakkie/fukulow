# Measurements

Writing: only results behind a decision, performance comparisons or key regression checks, with reproduction conditions and limits; no routine/debug logs, raw artifacts or duplicates; never silently rewrite or drop an old record.

Past measurement records: values, conditions, compared targets, methods, limits and commits. Evidence only: nothing here is a performance, capacity or latency guarantee of `docs/spec.md`. Current decisions drawn from these records live in `docs/decisions.md`.

How to use: do not read this file whole. Search the Issue number or topic and read that section only, when doing performance work, load tests, regression investigation or comparing results.

Rules for new records: keep results that affect a design decision, performance comparisons and important regression investigations; no routine test logs or debug output. State the conditions needed to reproduce and the limits. Do not commit large raw logs or artifacts. Do not compare runs with different methods or environments as a simple improvement rate. When a new measurement contradicts an old one, add it beside the old record with its conditions; never silently rewrite or delete the old record. One measurement is recorded once.

Record text is copied verbatim from its source line(s) (values and conditions unchanged). Raw logs, artifact directories and `/private/tmp` paths named in records were kept outside Git; they are not in this repository and may no longer exist, so they cannot be restored from here.

## Load harness methods (#20, #57)

Commands, metric definitions and limits of the load harness. Current rules: `docs/decisions/load.md` "Load testing and measurement".

### #20 heavy run command

- Source: [`docs/decisions.md` at 5023c62, line 72](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L72); added in 2dbc996 (PR #71).
- Issue: #20. Decision: `docs/decisions/load.md` "Load testing and measurement".

#20 manual heavy run once per milestone: `CHANNELS=1 SUBSCRIBERS=10000 PUBLISHERS=1 PUBLISH_INTERVAL_MS=100 DURATION_SECONDS=300 READY_TIMEOUT_SECONDS=60 make load` (same credentials/base URL as light); total sockets = CHANNELS × SUBSCRIBERS, PUBLISHERS is sends per batch distributed across Channels (superseded by #57 from in-flight workers); offered rate = PUBLISHERS × 1000 / PUBLISH_INTERVAL_MS, so this example offers 10 sends/s to 10,000 sockets (100,000 deliveries/s), and CHANNEL_VISIBILITY defaults to public (private also supported). Linux defaults to host networking; macOS uses `LOAD_DOCKER_NETWORK=bridge BASE_URL=http://host.docker.internal:8080`. Use a disposable database and record the commit, settings, server/database/generator resources and k6 output for identical before/after #57 comparisons; a single generator event loop can itself saturate, so this is not proof of server capacity.

### #20 metric definitions

- Source: [`docs/decisions.md` at 5023c62, line 73](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L73); added in 2dbc996 (PR #71).
- Issue: #20. Decision: `docs/decisions/load.md` "Load testing and measurement".

#20 metrics: concurrent_connections counts open sockets, subscribers_per_channel counts acknowledged subscriptions tagged by Channel index, concurrent_publishes counts outstanding HTTP sends, delivery_latency measures send-start to each unique WebSocket receipt on the generator clock, and publish_http_response_time includes the complete async HTTP round trip (http_req_duration is also tagged by operation). All sockets must acknowledge before publishing; missing deliveries, sequence gaps, protocol/HTTP errors and unexpected closes fail the run, with no reconnect masking loss. DB queries per send require separate database/server instrumentation in #57; the scaffold cannot infer them from the public API.

### #20 heavy-run limits

- Source: [`docs/decisions.md` at 5023c62, line 76](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L76); added in 2dbc996 (PR #71).
- Issue: #20. Decision: `docs/decisions/load.md` "Load testing and measurement".

#20 heavy-run limits: `make load` sets container `nofile` to 65536 (`LOAD_NOFILE` overrides it); check host/server limits and generator CPU before interpreting 10,000-socket results. External `timeout` can leave Docker running: CI names and explicitly removes its load container; manual bounded runs should set a unique `LOAD_CONTAINER_NAME` and remove it afterward. The modest #57 PR A baseline is recorded below; no 10,000-socket baseline or before/after optimization comparison has been collected.

### #57 `load-record` measurement command

- Source: [`docs/decisions.md` at 5023c62, line 95](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L95); added in 08d6364 (PR #132).
- Issue: #57. Decision: `docs/decisions/load.md` "Load testing and measurement".

#57 measurement command (macOS/Docker, disposable data): `CHANNELS=1 SUBSCRIBERS=20 PUBLISHERS=2 PUBLISH_INTERVAL_MS=100 DURATION_SECONDS=30 READY_TIMEOUT_SECONDS=15 DRAIN_TIMEOUT_SECONDS=10 LOAD_RESULT_DIR="$LOAD_ARTIFACTS" make load-record` (set `LOAD_ARTIFACTS` to a separate external artifact directory for each run). The runner creates a unique Compose project/image and dedicated PostgreSQL container, publishes only app port 18057 (`LOAD_PORT` overrides), uses bridge/host.docker.internal, and removes its own generator and Compose containers, network, disposable volumes and uniquely tagged app image. Shared PostgreSQL/k6 base images and Docker build cache remain; no global prune is used. It never uses shared `fukulow-pg-test`. `make load` remains the smoke scenario; use `load-record` for every before/after comparison. No new package: PostgreSQL's bundled pg_stat_statements extension is enabled only in the measurement Compose configuration.

### #57 artifacts and reporting method

- Source: [`docs/decisions.md` at 5023c62, line 96](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L96); added in 08d6364 (PR #132).
- Issue: #57. Decision: `docs/decisions/load.md` "Load testing and measurement".

#57 artifacts: metadata.json records source commit/dirty state, image IDs, host/Docker resources and transport; results.json records configured values, offered count/actual scheduling duration, offered sends/s (offered count divided by elapsed scheduling time), peak connections/publishes, k6 latency distributions/checks, timestamped docker stats CPU/memory/I/O samples (roughly every 2 seconds), and pg_stat_database/pg_stat_statements snapshots. SQL snapshots bracket publishing/draining after all subscriptions and before teardown; a one-second boundary pause allows capture. `handleSummary` replaces k6's readable console summary with the machine-readable LOAD_SUMMARY line. Queries exclude instrumentation. Report delta calls per offered send separately for top-level queries (excluding BEGIN/COMMIT/ROLLBACK), all top-level statements, and statements including nested FK checks. Session checks/fan-out SQL in this window are intentionally included. Inspect per-query deltas; pg_stat_database counters can lag and are supporting resource evidence, not the query-count denominator. CPU means include the one-second pre-publishing pause and the delivery drain (resource sampling spans the generator run). docker stats CPU uses 100% per core, memory is sampled container usage, and sampled peaks can miss short spikes. Preserve raw artifacts and repeat with identical configuration, image/tool versions, clean DB, Docker allocation and competing workload; no capacity conclusion from this modest single-generator run.

### #57 item 6 harness audit

- Source: [`docs/decisions.md` at 2599d3b, line 183](https://github.com/tkakkie/fukulow/blob/2599d3b9c0e79f336b5726c6f6fbbc31e5db08da/docs/decisions.md#L183); added in 2599d3b (PR #178).
- Issue: #57 item 6. Decision: `docs/decisions/load.md` "Load testing and measurement".

#57 item 6 audit: #132 already supplied response-independent absolute-deadline scheduling, SOCKETS_PER_SESSION, actual offered rate/peak connections and Docker/SQL resource recording. Final measurement adds baseline route compatibility, accepted/rejected rates and HTTP latency, Retry-After, reconnect counters, process RSS and failed-attempt provenance. Two initial single-batch windows ended before their configured 5 s; retain/exclude those artifacts, recheck deadlines after timer wakes (regression-tested), reject short windows, and rerun those points. No server contract or new dependency was introduced; measurement Compose pins the existing PostgreSQL image to 18.6.

## Load baselines and before/after (#57)

Fixed offered-load runs. Conditions differ between records (Docker version, commit, host load); compare only where a record says the conditions match.

### #57 PR A baseline (2026-11-09)

- Source: [`docs/decisions.md` at 5023c62, line 97](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L97); added in 08d6364 (PR #132).
- Issue: #57 PR A. Decision: `docs/decisions/load.md` "Load testing and measurement".

#57 PR A baseline (2026-11-09 17:06 UTC, implementation af199f9): Apple M5/10 CPU/32 GiB macOS arm64; Docker 29.9.2 VM 10 CPU/7.748 GiB, release app, PostgreSQL 18, k6 1.8.2, direct HTTP without proxy/TLS, fresh DB and no warm-up, alongside 6 other running containers. Command above: 1 public Channel × 20 subscribers, 20 sessions, batches of 2/100 ms for 30 s. Offered 600 sends/30.008 s = 19.9947/s, peak 20 connections and 2 concurrent publishes, 12,000 deliveries with zero missing/errors. Delivery mean/p95/p99 7.246/9/11 ms; HTTP 7.300/9/11.01 ms. DB: 6 top-level queries/send, 8 including transaction statements, 10.0017 including nested FK checks. Sixteen docker stats samples: generator CPU mean/peak 6.04/7.82%, peak memory 23.68 MiB; app 3.45/4.07%, 65.38 MiB; DB 7.50/9.76%, 84.60 MiB. Archive the raw baseline artifacts outside Git (CPU is per core and peaks are sampled). This intentionally modest baseline does not establish the 10k-connection target: the Docker VM has limited memory, shares resources with other projects, and one generator event loop can saturate. Reuse these exact conditions for PR B/C/D comparisons; repeat baselines when competing work or VM allocation changes.

### #57 PR C round 1 (2026-11-10 00:28 UTC)

- Source: [`docs/decisions.md` at 5023c62, line 109](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L109); added in c282fc8 (PR #154).
- Issue: #57 PR C. Decision: `docs/decisions/auth.md` "Sessions and revocation".

#57 PR C round 1 measurement (2026-11-10 00:28 UTC, final working tree on `4bfb077`): reran the exact #57 command above with a separate external `LOAD_RESULT_DIR`, fresh isolated DB, release app, Apple M5/10 CPU/32 GiB, Docker 29.9.3 VM 10 CPU/7.748 GiB, PostgreSQL 18, k6 1.8.2, direct HTTP. Offered 600 sends/30.000 s = 20/s; peak 20 sessions/sockets and 2 concurrent publishes; all 12,000 deliveries, zero missing/errors, all 1,244 checks passed. Delivery mean/p95/p99 6.817/10/12 ms; publish HTTP 5.740/8/10.01 ms. Exactly one batched fallback query checked all 20 sessions during the measurement window (0.045 ms execution). DB: 7.0017 top-level queries/send, 9.0017 including transaction statements, 11.0033 including nested FK checks; main now includes #135's extra recovery-barrier query, so old PR C figures before that merge are not directly comparable. Fifteen resource samples: generator CPU mean/peak 6.92/7.92%, peak memory 25.54 MiB; app 4.18/4.77%, 65.32 MiB; DB 6.42/7.96%, 82.36 MiB. Metadata, SQL snapshots, resource samples, k6 output and the server source diff are preserved in that artifact directory. This modest shared-host run supports no capacity or latency improvement claim; the runner removed its isolated containers, volume, network and app image.

### #57 item 6 final before/after (2026-11-10)

- Source: [`docs/decisions.md` at 2599d3b, line 184 to line 192](https://github.com/tkakkie/fukulow/blob/2599d3b9c0e79f336b5726c6f6fbbc31e5db08da/docs/decisions.md#L184-L192); added in 2599d3b (PR #178).
- Issue: #57 item 6. Decision: `docs/decisions/load.md` "Load testing and measurement".

- Final before/after (2026-11-10): before 8dd4168, immediate parent of the first hardening PR #134 (32c24ec); after release 1c6c7b7. Current harness against both; LOAD_LEGACY adapts only pre-#146 identity/routes. Apple M5/32 GiB, Docker 29.9.3 VM 10 CPU/7.748 GiB, Rust 1.99.0, PostgreSQL 18.6, k6 1.8.2, direct Docker-network HTTP, fresh DB, one run at a time, no publish warm-up or concurrent suites. One public Channel/Account/Member and 20 sessions; 30 s publishing: 20 sockets × 20 sends/s or 10,000 sockets × 2 sends/s. Three pairs per point, every accepted delivery received, zero rejections/unexpected closes. Values below are median [min–max] across runs; CPU, p50/p99 and full per-run configurations/resources are in the external report/artifacts.

| Sockets; configured sends/s | Version | Achieved sends/s | HTTP p95 ms | Delivery p95 ms | Top-level queries/send | Sampled server RSS MiB | Peak connections | Server / DB / generator CPU mean % (median) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 20; 20 | before | 19.9967 [19.9940–19.9993] | 7.0 [7.0–8.0] | 7.0 [7.0–7.0] | 6.000 [6.000–6.000] | 68.2 [68.2–68.2] | 20 | 3.8 / 6.9 / 6.0 |
| 20; 20 | after | 19.9993 [19.9987–20.0000] | 7.0 [7.0–7.0] | 8.0 [8.0–8.0] | 8.002 [8.002–8.002] | 68.9 [68.8–69.1] | 20 | 3.8 / 7.1 / 6.5 |
| 10000; 2 | before | 1.9996 [1.9995–1.9999] | 73.1 [73.0–89.0] | 163.0 [159.0–165.0] | 6.000 [6.000–6.000] | 1454.3 [1397.0–1454.4] | 10,000 | 43.4 / 3.2 / 63.3 |
| 10000; 2 | after | 1.9999 [1.9999–2.0000] | 6.0 [6.0–7.0] | 156.0 [156.0–163.0] | 8.017 [8.017–8.017] | 1434.2 [1433.9–1434.6] | 10,000 | 44.4 / 3.4 / 64.5 |
- Reading the table: the 6 -> 8 top-level queries per send is the Membership/revision authorization added by #146 (not a hardening regression). The 10,000-socket HTTP p95 drop (73.1 -> 6.0 ms) spans #134 through #173 plus #146, so it must not be attributed to any one change: before and after differ in more than the server (routes, auth model, fan-out and notification code). Same hardware, harness and workload, but not an ablation.

### #57 item 6 queue-cap sweep

- Source: [`docs/decisions.md` at 2599d3b, line 194 to line 206](https://github.com/tkakkie/fukulow/blob/2599d3b9c0e79f336b5726c6f6fbbc31e5db08da/docs/decisions.md#L194-L206); added in 2599d3b (PR #178).
- Issue: #57 item 6. Decision: `docs/decisions/realtime.md` "Admission and timeouts (queue caps 256/2,048)".

- Queue sweep: 16 public Channels × 625 subscribers = 10,000 sockets / 20 sessions; production admission otherwise unchanged. Channel caps 64/128/256/512 at global 2,048 publish to one hot Channel; global caps 1,024/2,048/4,096 at Channel 256 publish to all 16. Three fresh runs per cap/mode: steady 10 sends/s for 10 s (all 100 accepted; p95 delivery 23–25 ms), or one 2,048/8,192-send burst (launched in 57–594 ms; nominal one-batch window 5 s, longer if the generator end timer is delayed). Body 17 ASCII bytes. Below: burst median [min–max]; all accepted deliveries received, zero 1011/4008/reconnects, every 503 Retry-After was 1–5 s, no automatic send retry.

| Channel / global cap; publishing Channels | Accepted / offered | 503 % | Server RSS MiB | Accepted HTTP p95 ms | Delivery p95 ms |
|---|---:|---:|---:|---:|---:|
| 64 / 2048; 1 | 74 [71–74] / 2048 | 96.4 [96.4–96.5] | 1438.8 [1438.8–1449.0] | 471.1 [469.8–476.0] | 629.0 [622.0–635.0] |
| 128 / 2048; 1 | 136 [134–136] / 2048 | 93.4 [93.4–93.5] | 1455.7 [1444.5–1501.8] | 843.0 [816.7–862.3] | 1045.0 [1044.0–1071.0] |
| 256 / 2048; 1 | 265 [263–265] / 2048 | 87.1 [87.1–87.2] | 1449.7 [1442.3–1449.9] | 1576.8 [1430.6–1612.0] | 2063.0 [1977.0–2064.0] |
| 512 / 2048; 1 | 519 [519–521] / 2048 | 74.7 [74.6–74.7] | 1462.9 [1450.9–1518.0] | 3156.0 [3023.4–3181.0] | 4030.0 [3974.0–4057.0] |
| 256 / 1024; 16 | 1103 [1092–1108] / 8192 | 86.5 [86.5–86.7] | 1555.6 [1553.4–1560.1] | 6395.8 [6336.3–6864.0] | 9551.0 [9240.0–9806.0] |
| 256 / 2048; 16 | 2120 [2112–2149] / 8192 | 74.1 [73.8–74.2] | 1567.4 [1563.6–1572.8] | 11760.5 [11255.1–11955.8] | 18406.0 [17556.0–18577.0] |
| 256 / 4096; 16 | 4163 [4161–4183] / 8192 | 49.2 [48.9–49.2] | 1607.1 [1580.4–1609.3] | 24635.0 [22457.0–25460.0] | 33689.0 [33534.0–33955.0] |

- Keep 256/2,048: smaller caps increase refusals; larger caps absorb more burst but about double accepted HTTP/delivery delay without demonstrated service-capacity benefit here. Server RSS did not discriminate between the caps (about 1.44–1.46 GiB across the Channel caps, 1.56–1.61 GiB across the global caps), so the decision rests on latency and the 503 rate only; sampled RSS is dominated by sockets/HTTP/allocator behavior and is not a queue-only or maximum-payload bound. Accepted delay grows roughly with the cap in this receiver-limited setup (expected queueing), so this is a conservative choice, not an optimality claim. Admission logs confirm which cap rejected each request; pre-admission authorization still costs about two top-level queries per refusal, outside queue budgets. No fairness guarantee is added.

### #57 item 6 limits and reproduction

- Source: [`docs/decisions.md` at 2599d3b, line 209](https://github.com/tkakkie/fukulow/blob/2599d3b9c0e79f336b5726c6f6fbbc31e5db08da/docs/decisions.md#L209); added in 2599d3b (PR #178).
- Issue: #57 item 6. Decision: `docs/decisions/load.md` "Load testing and measurement".

Limits/reproduction: raw per-run CPU peaks, p50/p99 and configs are captured by the harness outside Git (the raw artifact directory also holds server logs and a source patch: do not attach it publicly); single machine, shared host, direct HTTP without TLS/proxy, one Member and 17-byte bodies; not a capacity guarantee. Delivery/HTTP callbacks include generator scheduling; resource peaks are sampled about every 2 s and CPU 100% means one core. Port-forwarded transport failed before publishing at 9,990 sockets (cause not established); direct networking passed at 10,000. At 20 sends/s to 10,000 recipients the generator missed its first send deadline after two accepted sends; no valid throughput/loss result is inferred. Thousands of writes/s, production TLS/network behavior, maximum-payload queue memory and natural recovery-fault frequency remain unproven. Raw logs, source/image identities, exact runners, full tables and excluded originals: the harness result directory (`LOAD_RESULT_DIR`, kept outside Git). Reproduce with LOAD_DIRECT_NETWORK=1, LOAD_SERVER_SOURCE pointing at the chosen worktree, LOAD_LEGACY=1 only for before, and the recorded scenario settings via make load-record.

## Ambiguous-COMMIT recovery barrier (#135)

### #135 recovery-barrier load run (2026-11-09 23:50 UTC)

- Source: [`docs/decisions.md` at 5023c62, line 107](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L107); added in c8d40a6 (PR #145).
- Issue: #135. Decision: `docs/decisions/realtime.md` "Real-time delivery (#135 cost)".

#135 recovery-barrier measurement (2026-11-09 23:50 UTC, clean implementation ec265e8): the #57 command above with a separate `LOAD_RESULT_DIR`, same Apple M5/10 CPU/32 GiB, Docker VM 10 CPU/7.748 GiB, PostgreSQL 18 and k6 1.8.2; Docker is now 29.9.3 (baseline 29.9.2), so this is not a controlled performance comparison. Offered 600 sends/30.005 s = 19.9967/s; peak 20 connections, 3 concurrent publishes; 12,000 deliveries, zero missing/errors. Delivery mean/p95/p99 8.754/25/69.05 ms; HTTP 7.682/23/65.04 ms. DB: 7 top-level queries/send, 9 including transaction statements, 11.0017 including nested FK checks; the barrier accounts for exactly 600 additional statements. Fourteen docker stats samples: generator CPU mean/peak 5.94/7.53%, peak memory 25.67 MiB; app 3.72/5.04%, 66.05 MiB; DB 5.85/8.91%, 90.09 MiB. Raw metadata, SQL snapshots, resource samples and k6 output are in that artifact directory; the modest load and shared-host sampling limitations above still apply.

## Watermark and send admission (#147, #156, #158, #199)

### #147 before/after (2026-11-10 00:17/00:21 UTC)

- Source: [`docs/decisions.md` at 5023c62, line 112](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L112); added in 9e2874b (PR #155).
- Issue: #147. Decision: `docs/decisions/realtime.md` "Admission and timeouts (connection budget)".

#147 before/after measurement (2026-11-10 00:17/00:21 UTC): clean main c8d40a6 versus its working-tree implementation, using the exact #57 command above and separate before/after artifact directories. Same Apple M5/10 CPU/32 GiB, Docker 29.9.3 VM 10 CPU/7.748 GiB, identical PostgreSQL 18/k6 1.8.2 image IDs, release app, bridge/direct HTTP, fresh DBs and no warm-up; one shared test-DB container remained running. Both offered 600 sends (30.001/30.002 s, 19.9993/19.9987 per second), peak 20 sockets/2 publishes, all 12,000 deliveries and zero errors/missing. Delivery mean/p95/p99: 6.254/11/22.01 -> 6.500/9/17 ms; HTTP: 5.233/9/20.03 -> 5.433/8/12.01 ms. Publishing-window SQL stays 7 top-level queries, 9 statements with transactions, 11.0017 including nested FK checks per send: subscription watermarks precede that window. CPU mean/peak (per core) and peak memory, before -> after: app 3.31/5.02%/65.12 MiB -> 4.03/4.99%/64.95 MiB; DB 6.19/11.66%/82.71 MiB -> 6.19/7.96%/82.37 MiB; generator 5.08/7.12%/25.86 MiB -> 6.43/7.57%/24.64 MiB (16/15 samples). A trial cap of five rejected 11 startup subscriptions before publishing; the final watermark cap of sixteen passes this burst and leaves four connections outside watermark work. Unresolved COMMITs and waiting sends could still occupy those four until #156. The trial produced incomplete artifacts. These single modest runs share a host with development/test work, use host Node 26.8.1 only to orchestrate the pinned Docker images, and do not establish a latency improvement or capacity target.

### #156 baseline before/after (2026-11-10 00:38/00:48 UTC)

- Source: [`docs/decisions.md` at 5023c62, line 117](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L117); added in 8b8b3c6 (PR #158).
- Issue: #156. Decision: `docs/decisions/realtime.md` "Admission and timeouts".

#156 baseline before/after (2026-11-10 00:38/00:48 UTC): clean main 9e2874b versus this working-tree implementation, exact #57 command above with separate artifact directories. Same Apple M5/10 CPU/32 GiB macOS arm64, Docker 29.9.3 VM 10 CPU/7.748 GiB, identical PostgreSQL 18/k6 1.8.2 image IDs, release app, direct HTTP/bridge, fresh isolated DBs, no warm-up and one shared test-DB container. Both offered 600 sends in 30.001/30.002 s (19.9993/19.9987 per second), peak 20 sockets/2 publishes, all 12,000 deliveries, zero errors/missing. Delivery mean/p95/p99: 6.692/10/20.01 -> 7.423/10/11 ms; HTTP: 5.587/9/16.04 -> 6.208/9/11 ms. SQL remains 7 top-level queries, 9 statements with transactions and 11.0017 including nested FK checks per send. Sampled CPU mean/peak (per core) and peak memory, before -> after: app 3.78/4.67%/65.16 MiB -> 4.09/5.08%/65.39 MiB; DB 6.07/8.59%/82.71 MiB -> 6.85/9.56%/85.96 MiB; generator 6.08/7.54%/25.84 MiB -> 6.22/8.30%/23.76 MiB (15/17 samples). Archive each run's metadata.json, results.json and k6.log outside Git as the #156 before/after artifact sets. Development/test work shared this host (including a short run of the send-deadline regression tests, which deliberately inject timeouts, during the after measurement; this was competing test work, not a load-run deadline failure); different sampling/drain windows and these single modest runs do not establish a latency change, high-write throughput or the 10k target.

### #156 round 1 (2026-11-10 01:10 UTC)

- Source: [`docs/decisions.md` at 5023c62, line 120](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L120); added in 8b8b3c6 (PR #158).
- Issue: #156. Decision: `docs/decisions/realtime.md` "Admission and timeouts".

#156 round 1 measurement (2026-11-10 01:10 UTC, working tree on abab3fa): exact #57 scenario above, with dedicated port 18158 and a separate external artifact directory, fresh isolated DB, release app, direct HTTP/bridge, same Apple M5/10 CPU/32 GiB and Docker 29.9.3 VM 10 CPU/7.748 GiB, PostgreSQL 18 and k6 1.8.2. Offered and completed 600 sends in 30.010 s (19.9933/s), peak 20 sockets/2 publishes; all 12,000 deliveries, zero errors/missing, all 1,244 checks passed. Delivery mean/p95/p99 5.862/10/12 ms; HTTP 4.838/8.05/10.01 ms. SQL: 7.0017 top-level queries, 9.0017 statements with transactions and 11.0033 including nested FK checks per send, including one batched session fallback query during the publishing window. Fifteen resource samples: app CPU mean/peak 3.72/4.64%, peak memory 65.68 MiB; DB 5.89/7.46%, 83.12 MiB; generator 5.56/7.46%, 26.00 MiB. Metadata, results, SQL/resource snapshots, k6 log and the measured source diff are preserved outside Git; the runner removed its isolated containers, volume, network and app image. Host Node 26.8.1 only orchestrates the pinned Docker images. Other development shared the host, but this worktree's tests finished before measurement; this single modest run establishes neither a latency improvement nor the 10k target.

### #158 maintainer-fix run (2026-11-10 01:44 UTC)

- Source: [`docs/decisions.md` at 5023c62, line 124](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L124); added in 8b8b3c6 (PR #158).
- Issue: #158. Decision: `docs/decisions/realtime.md` "Admission and timeouts".

#158 maintainer-fix measurement (2026-11-10 01:44 UTC, final working tree on 4a93575): exact #57 scenario above, dedicated port 18158, separate external artifact directory, fresh isolated DB, release app, direct HTTP/bridge and no warm-up. Same Apple M5/10 CPU/32 GiB, Docker 29.9.3 VM 10 CPU/7.748 GiB, PostgreSQL 18 and k6 1.8.2 image IDs as the prior run. Offered/completed 600 sends in 30.010 s (19.9933/s), peak 20 sockets/2 publishes; all 12,000 deliveries, zero errors/missing, all 1,244 checks passed. Delivery mean/p95/p99 6.961/10/11.01 ms; HTTP 5.718/8/9.01 ms. SQL remains 7.0017 top-level queries, 9.0017 statements with transactions and 11.0033 including nested FK checks per send, including one batched session fallback query. Transaction commands use the simple protocol as SQLx did; a preliminary prepared-command run was excluded from SQL comparisons because pg_stat_statements did not count every BEGIN/COMMIT execution. Fifteen resource samples: app CPU mean/peak 4.14/4.49%, peak memory 65.04 MiB; DB 6.68/7.57%, 82.96 MiB; generator 6.81/7.34%, 23.82 MiB. Metadata, results, SQL/resource snapshots, k6 output and measured source diff are preserved outside Git; the runner removed its isolated containers, volume, network and app image. The shared test-DB container remained running; this worktree's tests had completed before measurement. Host Node 26.8.1 only orchestrated pinned Docker images. This single modest shared-host run supports no latency improvement, high-write throughput or 10k capacity claim.

### #158 backend-residue fault measurement

- Source: [`docs/decisions.md` at 5023c62, line 128](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L128); added in 8b8b3c6 (PR #158).
- Issue: #158. Decision: `docs/decisions/realtime.md` "Admission and timeouts (barrier timeouts)".

#158 residue measurement (PostgreSQL 18.6, max_connections=100, client_connection_check_interval=0, Docker fukulow-pg-test): before the fix, three same-key sends on one Channel each failed after about 10.07 s, freed all app pool connections, but left one sleeping COMMIT backend with 19 locks; retries did not accumulate COMMIT backends on that Channel. Three more distinct Channels increased residue to four backends/69 locks after another 10.16 s. All production lock timeouts remained enabled; 36 unrelated Organization HTTP write/read/subscription probes passed. This reproduced cross-Channel accumulation, not max_connections exhaustion or an indefinitely running load. After the fix the same four rounds ended in 8.069/8.079/8.079/8.167 s with zero backend/lock/pool residue after every round and 28 unrelated probes passed. A separately abandoned sleeping COMMIT released its backend and all 19 locks after 8.018 s on the PostgreSQL clock, while reconnect waited for rollback; committed/rolled-back/unknown-result recovery tests still passed. These are local fault measurements, not throughput or capacity measurements.

### #199 per-Channel watermark cap comparison (2026-11-11)

- Issue: [#199](https://github.com/tkakkie/fukulow/issues/199).
- Decision: `docs/decisions/realtime.md` "Admission and timeouts"; maintainer chose option 2 on 2026-11-11: measured, keep cap 4; do not merge the cap-2 change.

Local macOS ARM64, release test binaries, same host and workloads, with only `CHANNEL_WATERMARK_CAP` differing. The probe was `server/src/realtime/tests/watermark_measurement.rs::measure_popular_channel_watermark_reconnects` on local, unpushed commit `0c78225` (`codex/watermark-cap-199`). It is not in main, which limits reproduction from main alone. No new measurement was run for this record.

Method: a 20-connection pool and one popular Channel. Steady state uses 128 workers, each making 40 sequential TCP reconnect/subscribe attempts (5,120 total). Recovery first establishes 10,000 clients, drops all sockets, then retries with seeded jittered exponential backoff (initial 250–750 ms, base capped at 10 s, jitter 0.5–1.5, up to 20 attempts); recovered sockets stay connected and must all receive the canonical live Message. Subscribe p95/p99 measure successful subscribe latency, excluding TCP/authentication and backoff; phase successes/s and full recovery include those costs. Admission rejections are counted from logs separately from Close frames and handshake errors.

First single pair, with another AI job overlapping near the end:

| Scenario | Cap | Successes/s | Subscribe p95 / p99 (ms) | 1011 admission rejections | Handshake errors | Full recovery (s) |
|---|---:|---:|---:|---:|---:|---:|
| 128 workers, 5,120 subscribes | 4 | 1,271.7 | 105.1 / 107.0 | 0 | NR | — |
| Same | 2 | 878.3 | 150.9 / 152.6 | 0 | NR | — |
| 10,000 clients, backoff | 4 | 221.2 | 2,109.9 / 6,111.7 | 15,791 | 17,442 | 45.2 |
| Same | 2 | 220.2 | 2,091.1 / 2,162.9 | 20,741 | 15,883 | 45.4 |

Both caps recovered all 10,000 clients within 8 attempts and delivered the canonical live Message to all. Popular-Channel throughput fell 30.9% at cap 2 in this pair.

Re-measurement on an idle host with no other AI job running: alternating cap order 4, 2, 2, 4, 4, 2, with 10 s gaps. Run numbers below are within each cap, in chronological order.

| Steady-state cap | Run 1 successes/s | Run 2 successes/s | Run 3 successes/s | Subscribe p95 (ms) | Subscribe p99 (ms) | 1011 admission rejections | Handshake errors | Full recovery |
|---|---:|---:|---:|---:|---:|---:|---|---|
| 4 | 1,219 | 1,211 | 1,239 | 110–113 | 113–116 | 0 | NR | — |
| 2 | 842 | 847 | 849 | 156–160 | 159–161 | 0 | NR | — |

The source retains only p95/p99 ranges across the three steady-state runs, not each run's percentiles. Throughput spread is under 3%; cap 2 is about 31% slower with about 40% higher p99.

| 10,000-client backoff cap | Run | Successes/s | Subscribe p95 / p99 (ms) | 1011 admission rejections | Handshake errors | Full recovery (s) |
|---|---:|---|---:|---:|---:|---:|
| 4 | 1 | NR | 7,634 / 7,784 | 13,924 | 18,564 | 46.0 |
| 4 | 2 | NR | 2,027 / 5,106 | 13,170 | 18,894 | 45.4 |
| 4 | 3 | NR | 6,897 / 6,987 | 13,800 | 18,752 | 45.8 |
| 2 | 1 | NR | 2,388 / 7,628 | 19,325 | 16,311 | 44.9 |
| 2 | 2 | NR | 2,236 / 7,142 | 20,148 | 16,153 | 45.4 |

NR means not reported in the retained measurement data; — means not applicable. The third cap-2 recovery run failed during setup (initial connection before the outage) and is excluded, not a result. Ephemeral-port or listen-backlog exhaustion from the preceding run was suspected, not established.

Prediction only, separate from measured results: at 4 ms per watermark, reducing cap 4 to 2 was expected to reduce popular-Channel throughput from ~1,000/s to ~500/s.

The repeated measurements show about 45% more recovery-time 1011 admission rejections at cap 2, with no significant improvement in full recovery (about 45 s at either cap). Cap 2's steadier p95 did not establish a p99 benefit: repeated p99 values overlap, so the first single-run p99 difference did not hold up. This measured performance cost did not justify cap 2; it does not mean cross-tenant failure spread is solved. Two stuck Channels can still hold all 8 watermark slots and make another Organization's subscribe fail with 1011; #213 considers per-Organization watermark fairness only if that spread becomes a real problem.

Limits: local measurement with host listen backlog 128 and more than 16k handshake errors at either cap in the re-measurement; recovery is bounded by handshake capacity. This does not guarantee 10,000-connection capacity in production. The first pair also shared the host with another AI job, the repeated recovery sample has only two valid cap-2 runs, and the probe code is not in main. Follow-up #212 covers handshake admission, listen backlog and accept pacing; client jitter is in #195.

## Session fallback pass (#157, #146)

### #157 load before/after (2026-11-10 01:09/01:17 UTC)

- Source: [`docs/decisions.md` at 5023c62, line 132](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L132); added in 35c2ae6 (PR #162).
- Issue: #157. Decision: `docs/decisions/auth.md` "Sessions and revocation".

#157 measurements (2026-11-10 01:09/01:17 UTC): clean main c282fc8 versus the final server implementation, using the exact #57 `load-record` command/configuration above, 1 public Channel, 20 distinct sessions/sockets, 2 sends/100 ms for 30 seconds, fresh isolated DBs, release images and no warm-up. Apple M5/10 CPU/32 GiB; Docker 29.9.3 VM 10 CPU/7.748 GiB; identical PostgreSQL 18.6 and k6 1.8.2 image IDs, direct HTTP/bridge, one shared test-DB container. Before -> after: 600 sends in 30.001 -> 30.002 s (19.9993 -> 19.9987/s), peak 20 sockets/2 publishes, all 12,000 deliveries, zero missing/errors and all 1,244 checks passed in both runs. Delivery mean/p95/p99 6.036/9/14 -> 6.814/9/10 ms; publish HTTP 5.032/8/12.01 -> 5.763/8/9 ms. Both issue exactly one fallback query for 20 sessions (0.053 -> 0.068 ms SQL execution); SQL/send is unchanged at 7.0017 top-level queries, 9.0017 statements with transactions and 11.0033 including nested FK checks. Fifteen resource samples each: app CPU mean/peak 3.84/4.65 -> 4.01/4.62%, peak memory 65.13 -> 65.45 MiB; DB 5.92/9.77 -> 6.42/7.30%, 89.71 -> 90.16 MiB; generator 5.75/6.96 -> 6.57/7.19%, 25.82 -> 25.65 MiB. External artifact bundles are named `fukulow-157-before` and `fukulow-157-after` (metadata, SQL snapshots, resources and k6 output); isolated load containers, networks, volumes and app images were removed. These single modest shared-host runs, including other development work, establish neither a latency improvement nor WebSocket capacity.

### #157 pass deadline and measurement test (method)

- Source: [`docs/decisions.md` at 5023c62, line 131](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L131); added in 35c2ae6 (PR #162).
- Issue: #157. Decision: `docs/decisions/auth.md` "Sessions and revocation (fallback worker)".

#157 keeps a single 5-second absolute deadline from pass start, including registry snapshot/key preparation, pool acquisition and every 1,000-session chunk; the 30-second cadence and 35-second detection bound remain, plus runtime scheduling and close-send delivery. No partial successful result is trusted: any query error/deadline fails the entire snapshot closed with 1011, including sessions in completed and unprocessed chunks. New connections can establish a fresh epoch after a pass failure only while the worker is available and current SQL authorizes them. There is no session-count cap; de-duplication is by Organization/token hash, never WebSocket count. Deterministic tests use registration/check barriers, PostgreSQL locks and controlled Tokio time rather than fixed-delay races. The manual release-mode `measure_distinct_session_pass_within_five_seconds` test measures the production pass with 1,000/10,000/100,000 distinct valid sessions against PostgreSQL, including snapshot, SQL and result application; provisioning is outside the timed interval.

### #157 distinct-session pass

- Source: [`docs/decisions.md` at 5023c62, line 133](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L133); added in 35c2ae6 (PR #162).
- Issue: #157. Decision: `docs/decisions/auth.md` "Sessions and revocation (no session-count cap)".

#157 distinct-session measurement: `cargo test --release -p fukulow-server measure_distinct_session_pass_within_five_seconds -- --ignored --nocapture` against a fresh disposable database on PostgreSQL at loopback, using the same shared host/test-DB container. With 100,000 valid rows provisioned and ANALYZE completed first, the actual production pass verified 1,000/10,000/100,000 distinct sessions (1/10/100 chunks) in 16.086/89.648/253.199 ms respectively, each within one 5,000 ms deadline, including snapshot and result application. This tests one Organization, an available pool and local PostgreSQL, without 100,000 WebSockets or concurrent publishing; it is evidence for keeping the deadline without a count cap, not a production capacity guarantee. The controlled-clock 20,000-registration denial test separately verifies fail-closed behaviour with pool acquisition blocked through the deadline.

### #146 fallback regression measurement

- Source: [`docs/decisions.md` at 5023c62, line 150](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L150); added in a0b1b06 (PR #171).
- Issue: #146. Decision: `docs/decisions/auth.md` "Sessions and revocation (no session-count cap)".

#146 release fallback regression measurement (2026-11-10, Apple M5, Rust 1.99.0, PostgreSQL 18.6 in fukulow-pg-test at loopback): the #157 ignored production-pass measurement with 100,000 valid Account Sessions provisioned and ANALYZE outside timing, one Account/Member/Organization and distinct token hashes, measures snapshot/key preparation, 1,000-key SQL chunks and result application. Clean pre-change main 7e8f5e9 versus this implementation: 1,000/10,000/100,000 registrations (1/10/100 chunks) took 32.305/133.233/263.841 ms before and 4.082/31.134/329.113 ms after the origin/main merge, each within one 5,000 ms deadline. Added Membership state/revision checks and explicit cause classification remain within the deadline in these runs. The global token primary key and query shape also changed; these single shared-host runs (with other development activity) do not isolate join cost or establish an improvement, Member-count scalability, 100,000 live sockets, concurrent publishing capacity or a production latency guarantee. Earlier after runs were 3.363/18.978/212.693 ms and 3.126/21.992/196.494 ms; no warm-up or outlier selection was used. Commands/logs are recorded outside Git in the #146 result report; the controlled-clock deadline denial tests independently verify fail-closed behaviour.

### #146 review round 1 fallback measurement

- Source: [`docs/decisions.md` at 5023c62, line 159](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L159); added in a0b1b06 (PR #171).
- Issue: #146. Decision: `docs/decisions/auth.md` "Sessions and revocation (no session-count cap)".

#146 review round 1 release fallback measurement (2026-11-10, working tree on 907d017; Apple M5/32 GiB, Rust 1.99.0, PostgreSQL 18.6 at loopback in fukulow-pg-test): the ignored production-pass test now provisions 100,000 distinct Accounts, Members and Account Sessions across ten Organizations, with ANALYZE and provisioning outside timing. Three consecutive runs of `cargo test --release -p fukulow-server measure_distinct_session_pass_within_five_seconds -- --ignored --nocapture`, each on a fresh SQLx disposable database and with this worktree's other Rust/web suites stopped, measured 1,000/10,000/100,000 registrations (1/10/100 chunks): run 1 8.902/24.541/282.689 ms; run 2 11.219/27.478/269.827 ms; run 3 11.065/26.276/280.294 ms. These are all attempts with this revised data set, with no discarded runs or extra warm-up. Every pass, including snapshot, SQL and result application, completed inside its one 5,000 ms deadline; the production 30 s cadence and 5 s deadline stay unchanged. The earlier one-Account/Member/Organization measurements above remain historical and cannot establish Member-count scalability. This shared-host, available-pool/local-DB check is neither a controlled before/after join-cost comparison nor evidence for 100,000 live sockets, concurrent publishing, production capacity or latency. All three raw logs are retained outside Git in the #146 result report.

## Restart policy (#163)

### #163 observed restart-policy check

- Source: [`docs/decisions.md` at 5023c62, line 141](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L141); added in cb3c05c (PR #164).
- Issue: #163. Decision: `docs/decisions/auth.md` "Sessions and revocation (#163 manual check)".

#163 observed restart-policy check (2026-11-10, clean commit fcbe98e8268b3604557623031a8ff06664cd66f6): in-container SIGKILL was ignored; the host-namespace kill produced `die exitCode=137`, `RestartCount` 0 -> 1, and `/api/v1/health` returned `ok` again after resolving the reassigned loopback port. Cleanup removed all isolated containers, network, DB volume and app image.

## Notification-failure signalling (#136)

Polling (before) versus event-driven watches (after), on one current-thread runtime with server and clients in one process.

### #136 initial idle CPU comparison

- Source: [`docs/decisions.md` at 5023c62, line 165](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L165); added in 96b9cbe (PR #172).
- Issue: #136. Decision: `docs/decisions/realtime.md` "Real-time delivery (#136 evidence)".

#136 initial release comparison, before review round 1 (2026-11-10, Apple M5/macOS arm64, Rust 1.99.0, Docker PostgreSQL 18.6 at loopback): main `a0b1b06` polling versus initial event implementation `fa911b9`, using the ignored `measure_idle_sockets_and_notification_failure_latency` probe with identical provisioning and no concurrent suites. Each run established 10,000 real sockets with ten public subscriptions each, sharing one Account Session/Member, on the SQLx test's current-thread runtime. External `ps -o time=` sampling around a 20.001 s idle window measured combined server + Rust-client CPU: 11.640 -> 0.580 CPU seconds, 58.197 -> 2.900% of one core (0.01 s CPU precision; heartbeat/fallback included). The first baseline reached 10,000 sockets but failed before measurement when in-process `ps` spawning returned EBADF; sampling was moved outside the high-FD process and both successful runs used that sampler.

### #136 initial 1011 latency

- Source: [`docs/decisions.md` at 5023c62, line 166](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L166); added in 96b9cbe (PR #172).
- Issue: #136. Decision: `docs/decisions/realtime.md` "Real-time delivery (#136 evidence)".

#136 initial 1011 receipt latency from saturated-send start (including HTTP/persistence), min/median/p95/max ms: at 10,000 sockets, 4.214/119.476/173.035/175.421 -> 132.546/156.988/178.543/180.964; every socket received 1011. This is one failure per run with 10,000 observations; bulk wake/close scheduling and cleanup remain costs, and median/p95 did not improve. A separate one-socket pair measured 34.868 -> 2.285 ms. Command: `MEASURE_SOCKETS=10000 cargo test --release -p fukulow-server --lib measure_idle_sockets_and_notification_failure_latency -- --ignored --nocapture` (repeat with 1; sample CPU externally between printed phase markers). Raw logs/runner are outside Git under `/private/tmp/fukulow-136-*`, detailed in the result report. These shared-host samples demonstrate lower idle CPU in this setup, not isolated production-server CPU, independent-failure percentiles, throughput, capacity or a latency guarantee.

### #136 bulk-close interpretation

- Source: [`docs/decisions.md` at 5023c62, line 169](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L169); added in 96b9cbe (PR #172).
- Issue: #136. Decision: `docs/decisions/realtime.md` "Real-time delivery (#136 evidence)".

#136 bulk-close interpretation: the initial polling-to-event median rose 119.476 -> 156.988 ms and minimum 4.214 -> 132.546 ms because one `send_replace` wakes all 10,000 server tasks at once on the probe's current-thread runtime, queuing client tasks behind that batch. This is a same-runtime scheduling artifact; these measurements have not shown a production latency regression, and the review-round monitor adds another scheduled task (an extra hop under 10,000 simultaneous wakes) before each socket observes failure.

### #136 review round 1 RSS

- Source: [`docs/decisions.md` at 5023c62, line 170](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L170); added in 96b9cbe (PR #172).
- Issue: #136. Decision: `docs/decisions/realtime.md` "Real-time delivery (#136 evidence)".

#136 review round 1 release RSS (N2, same machine/runtime/probe as above): fresh `fa911b9` before versus the fixed implementation, sequential runs with no concurrent suites; external `ps -o rss=` at start/end of the settled 20 s idle window. At 10,000 sockets × 10 subscriptions, before 2,732,000/2,732,080 KiB and after 2,738,032/2,737,984 KiB (end: 2,668.047 -> 2,673.813 MiB, +5.766 MiB / 0.216%). RSS includes both server and Rust clients, harness, allocator retention and the post-fix test-only shared epoch poll counters; this is not isolated per-task or production-server memory. CPU over that same window was 0.610 -> 0.560 seconds (3.050 -> 2.800% of one core). Logs/runner: `/private/tmp/fukulow-136-round1-{before,after}-10.log`, `/private/tmp/fukulow-136-round1-measure.ts`.

### #136 review round 1 refreshed 10,000-socket latency

- Source: [`docs/decisions.md` at 5023c62, line 171](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L171); added in 96b9cbe (PR #172).
- Issue: #136. Decision: `docs/decisions/realtime.md` "Real-time delivery (#136 evidence)".

#136 review round 1 refreshed 10,000-socket 1011 latency, min/median/p95/max ms from saturated-send start: 121.763/145.143/165.738/168.176 before -> 137.032/166.222/192.966/196.077 after; every socket received 1011. These fresh pairs supersede the initial event implementation's performance numbers for this fix, while the historical polling comparison above remains as recorded. One shared-Channel failure per run, bulk task/close scheduling on the same current-thread server/client runtime and a shared host do not establish production regression, capacity or independent-failure percentiles.

### #136 review round 1 high-subscription point

- Source: [`docs/decisions.md` at 5023c62, line 172](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L172); added in 96b9cbe (PR #172).
- Issue: #136. Decision: `docs/decisions/realtime.md` "Real-time delivery (#136 evidence)".

#136 review round 1 high-subscription point, same release method: 1,000 sockets × 256 subscriptions, before RSS start/end 414,976/415,040 KiB -> after 415,616/415,648 KiB (end: 405.313 -> 405.906 MiB, +0.594 MiB / 0.146%). Idle CPU 0.130 -> 0.100 seconds (0.650 -> 0.500% core); 1011 min/median/p95/max 112.347/114.409/116.116/116.290 -> 114.401/116.593/118.389/118.575 ms, every socket closed. This is the largest high-subscription point tested here; 10,000 × 256 was not attempted because the sequential SQL/subscribe provisioner took 529.95/509.85 s for 1,000 × 256 (roughly 88 minutes per full-size run by extrapolating the before run). It is not a demonstrated resource limit. Raw logs use the same prefix with `-256.log`.

### #136 review round 1 single-socket latency

- Source: [`docs/decisions.md` at 5023c62, line 173](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L173); added in 96b9cbe (PR #172).
- Issue: #136. Decision: `docs/decisions/realtime.md` "Real-time delivery (#136 evidence)".

#136 review round 1 refreshed one-socket/ten-subscription 1011 latency: 2.318 -> 2.337 ms. Idle CPU 0.010 -> 0.000 seconds is below useful comparison precision (0.01 s sampling); logs use `-single.log`. All six review-round probes passed, with no discarded attempts. The original main-to-event single-socket pair above remains historical; none of these single-event samples establishes a production latency guarantee.

## Fan-out and reorder recovery (#57 item 4, #57 item 6)

### #57 item 4 visibility query plans (EXPLAIN)

- Source: [`docs/decisions.md` at 5023c62, line 176](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L176); added in 1c6c7b7 (PR #173).
- Issue: #57 item 4. Decision: `docs/decisions/realtime.md` "Real-time delivery (#57 item 4 visibility)".

#57 item 4 visibility: auth owns the active-Member predicate and captured-revision/candidate filters; Channels owns one shared public/private grant predicate and visibility query builder. History, pre-admission reads, subscribe, replay and fan-out are non-locking; only persistence and Channel creation retain FOR SHARE through COMMIT. Batched candidates are bounded by id = ANY($3) and still matched as (Member, revision) pairs. Fresh authorization, stale/deactivated denial, old private-grant invalidation, organization_unavailable/Channel denial and 4001/4003 classifications are preserved. Release EXPLAIN (ANALYZE, BUFFERS), 10,000 active Members after ANALYZE: 128 candidates changed a 10,000-row users sequential scan (1.039 ms whole query) to a 128-row bitmap heap/index scan (0.138 ms); 1,024 candidates: 10,000-row scan/1.429 ms -> 1,024-row bitmap scan/0.813 ms. A single candidate already used users_pkey before (0.019 -> 0.018 ms); the old query did not always scan the Organization. These are individual plans, not latency guarantees.

### #57 item 4 release probe

- Source: [`docs/decisions.md` at 5023c62, line 177](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L177); added in 1c6c7b7 (PR #173).
- Issue: #57 item 4. Decision: `docs/decisions/realtime.md` "Real-time delivery (#57 item 4)".

#57 item 4 release probe (2026-11-10, Apple M5/32 GiB, Rust 1.99.0, Docker 29.9.3 PostgreSQL 18.6 at loopback; isolated measurement container with pg_stat_statements, fresh SQLx database per run, no warm-up or concurrent Rust suite): main 96b9cbe plus the probe versus this implementation, 200 sequential HTTP sends and real WebSocket receipts per point. At 1/10,000 active Organization Members with 128 sockets sharing one Member/Session, median/p95 send-start-to-last-receipt ms were 3.274/3.656 -> 3.062/3.471 and 3.360/3.674 -> 3.246/3.536. Combined server/client/harness CPU was 0.210 -> 0.210 seconds at both points (ps, 0.01 s precision); normal publishing stayed at 8 top-level queries + BEGIN/COMMIT per send, including one fan-out query. One socket/one Member: 2.647/2.870 -> 2.272/2.752 ms and 0.050 -> 0.050 CPU seconds. Non-locking single visibility reads, 1,000 calls: 379.196 -> 321.236 ms; one-candidate batched reads in the 10,000-Member Organization: 396.867 -> 369.527 ms. These single, short, shared-host samples show no demonstrated CPU improvement or production capacity/latency guarantee.

### #57 item 4 forced reorder

- Source: [`docs/decisions.md` at 5023c62, line 178](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L178); added in 1c6c7b7 (PR #173).
- Issue: #57 item 4. Decision: `docs/decisions/realtime.md` "Real-time delivery (#57 item 4 evidence)".

#57 item 4 forced reorder in the same release probe: pause the first committed notification, publish the next Message, receive both in order, release the late notification and drain tasks. With 128 sockets, total top-level SQL in that window fell 779 -> 12 statements (521 -> 10 excluding transaction control) at both Organization sizes; gap-page reads fell 128 -> 1, without per-socket watermarks/refills. Time to both receipts on every socket: 92.320 -> 7.107 ms (1 Member), 94.439 -> 5.838 ms (10,000 Members). One socket: 17 -> 12 statements, 4.766 -> 3.758 ms. Commands (DATABASE_URL set to a Postgres with pg_stat_statements preloaded): `for members in 1 10000; do for sockets in 1 128; do MEASURE_MEMBERS="$members" MEASURE_SUBSCRIBERS="$sockets" cargo test --release -p fukulow-server --lib measure_fanout_and_reorder -- --ignored --nocapture; done; done`; measure_visibility_reads_and_candidate_plan checks old/bounded/production SQL plans on the same data. Raw per-query logs are outside Git at /private/tmp/fukulow-57i4-{before,after}-{1,10000,single,visibility}.log. These are focused item 4 probes with response-paced sends, not item 6's fixed offered-load comparison, 10,000 live sockets, independent reorder percentiles or queue-cap tuning.

### #57 item 6 notification-permit fault probe

- Source: [`docs/decisions.md` at 2599d3b, line 207](https://github.com/tkakkie/fukulow/blob/2599d3b9c0e79f336b5726c6f6fbbc31e5db08da/docs/decisions.md#L207); added in 2599d3b (PR #178).
- Issue: #57 item 6. Decision: `docs/decisions/realtime.md` "Admission and timeouts (#179 starvation)".

Review-note fault probe (three release runs, 9,999 hot sockets + one cold socket; 512 concurrent Router sends, real WebSockets, production 20-connection pool and 256/2,048 caps): holding the hot publication cursor occupies all 40 notification permits. Each run accepts 257/rejects 255; the cold send returns 201 and reaches 1011 within 2.113–2.209 ms of send start. Reconnect overlap retains cursor 40; after replaying all 257 commits, the next publication crosses a 217-Message gap and forces a second hot reconnect cycle: 19,998 forced hot reconnects/run. First/second sequential replay takes 71.138–71.371 / 32.065–32.076 s; every seq is checked and both Channels resume live delivery. No Message is lost (replay delivers every seq once); the cold Channel only suffers a spurious disconnect. This controlled same-runtime probe measures failure/recovery, not natural reorder frequency or isolated server resource use.

### #179 notification execution isolation (2026-11-10)

One completed before/after pair: baseline `8d6c916` versus this #179 change. Apple M5/macOS 27.0.1 arm64, Rust 1.99.0, Docker PostgreSQL 18.6 at `127.0.0.1:55432`; native release SQLx current-thread probe, real loopback WebSockets and Router sends in the same process. Each run starts 9,999 hot sockets plus one cold socket, a 20-connection pool and unchanged 256/2,048 send queue caps. No other build, test suite or load probe ran concurrently; ordinary desktop/background processes remained active.

Reproduce with `DATABASE_URL` pointing at that PostgreSQL: `MEASURE_SOCKETS=9999 MEASURE_SENDS=512 cargo test --release -p fukulow-server --lib realtime::tests::measurement -- --ignored --nocapture --test-threads=1`. Hold the hot publication cursor, commit a 512-send concurrent burst, send on the cold Channel, then release the cursor after overlapping the first hot replay. Check every replay seq and the subsequent >50-gap latch. The after probe continuously reads the original cold socket (answering Pings during the long replays), rejects any Close frame, and checks three live Messages through both hot recovery cycles. Baseline expects a cold 1011 and later replays its committed Message.

| Observation | Before | After |
|---|---:|---:|
| Accepted / rejected hot sends | 257 / 255 | 257 / 255 |
| Hot burst HTTP completion (ms) | 741.419 | 658.275 |
| Cold send outcome, elapsed from send start | 1011 at 2.319 ms | Live Message at 3.038 ms; zero 1011 |
| Available global execution permits during held cursor | 0 | 40 |
| Recovered hot cursor / next gap | 40 / 217 | 40 / 217 |
| First hot close completion from burst start (ms) | 746.707 | 664.265 |
| First sequential hot replay (ms) | 80,484.031 | 74,885.677 |
| Second hot close completion from next send (ms) | 129.589 | 128.758 |
| Second sequential hot replay (ms) | 33,673.199 | 33,985.937 |
| Forced hot reconnects | 19,998 | 19,998 |

This confirms cold live progress under a held hot cursor, with unchanged hot admission, cursor, large-gap latch and two-cycle recovery outcomes in this probe. It does not establish latency distributions, production throughput/capacity, peak memory for the new 2,048-task ceiling, natural reorder frequency, or fairness when many Channels exhaust the shared reservation/execution budgets. One completed pair on a host with background activity cannot attribute timing differences to the change or establish latency guarantees. Raw logs were kept outside Git (temporary, not retained).

### #190 per-Organization notification reservations (2026-11-10)

Controlled #178/#189 held-cursor method, extended in `server/src/realtime/tests/measurement.rs::measure_organization_notification_reservations`: baseline `4f56630` (only test instrumentation added), temporary 256 candidate, then final 512 implementation. Apple M5, 10 CPU, 32 GiB, macOS 27.0.1 arm64, Rust 1.99.0, Docker PostgreSQL 18.6 on loopback. Native release SQLx current-thread runtime, real loopback WebSockets, in-process Router sends, production 20-connection pool and unchanged 256/2,048 send admission caps. Each run used a fresh SQLx database. No other build, test suite or load probe ran concurrently; desktop, agent and background processes remained, so this was not a machine-wide idle or isolated production-server measurement.

Reproduce with `DATABASE_URL` set: `MEASURE_RESERVATIONS=2048 MEASURE_ORG_CAP=512 cargo test --release -q -p fukulow-server --lib measure_organization_notification_reservations -- --ignored --nocapture --test-threads=1`. Use `MEASURE_RESERVATIONS=512` for the chosen-cap workload; baseline uses `MEASURE_ORG_CAP=2048`. To evaluate 256, change `MAX_ORGANIZATION_NOTIFICATIONS` to 256 and use `MEASURE_ORG_CAP=256`, then restore 512. The test-only snapshot on baseline reports global usage; its absent Organization map is marked n/a below.

Before each fault, send 320 concurrent Messages across 16 healthy A Channels on one draining socket; assert every per-Channel seq 1..20 and all HTTP 201. Then hold real A publication cursors across ceil(offered/40) Channels, commit the offered burst (all 201), and snapshot reservations before any release. B uses the same Channel UUID as A's affected Channel, another Organization and the same Delivery. Send on B, then on a fresh A Channel, asserting either live delivery or 1011 as appropriate; reconnect/replay A's affected Message before releasing the hot cursors. Drain tasks, check zero reservations/entries, and verify A and B resume live. Healthy traffic has no injected delay; the held-cursor workload is artificial.

| Observation | Before, 512 offered | Before, 2,048 offered | 256 candidate, 2,048 offered | 512 chosen, 512 offered | 512 chosen, 2,048 offered |
|---|---:|---:|---:|---:|---:|
| Healthy deliveries / healthy completion ms | 320 / 212.402 | 320 / 214.177 | 320 / 254.938 | 320 / 342.768 | 320 / 216.952 |
| Held-burst HTTP completion ms | 267.186 | 1,054.916 | 1,434.383 | 340.965 | 1,149.989 |
| Held reservations / Organization entries | 512 / n/a | 2,048 / n/a | 256 / 1 | 512 / 1 | 512 / 1 |
| Free global execution permits | 40 | 40 | 40 | 40 | 40 |
| B outcome / ms from send start | Live / 2.134 | 1011 / 1.847 | Live / 2.612 | Live / 2.745 | Live / 2.199 |
| A affected Channel outcome / ms | Live / 2.121 | 1011 / 1.789 | 1011 / 2.221 | 1011 / 2.800 | 1011 / 2.543 |
| A affected Channel replay ms | n/a | 4.701 | 4.891 | 4.914 | 5.357 |
| Reservations / entries after drain | 0 / n/a | 0 / n/a | 0 / 0 | 0 / 0 | 0 / 0 |
| A and B subsequent live delivery | yes | yes | yes | yes | yes |

Both candidates stop A's reservation monopoly. Chosen 512 leaves at least 1,536 global slots beyond A, versus 1,792 for 256, and allows twice the transient Channel backlog (12 full 40-task Channels plus 32 slots versus six plus 16). All five healthy runs delivered every Message without 1011/4008; these single samples do not show a latency benefit or regression. A's earlier 1011 at 512 is the intended bounded-overload trade-off; its affected Channel replayed and resumed live.

This proves only the controlled single-Organization reservation scenario. Simultaneous multi-Organization exhaustion, the 40 shared execution permits, DB/send admission contention and reconnect costs remain; no cross-Organization fairness is established. The probe does not replay all held Channels or repeat the old 9,999-socket reconnect measurement; existing gap, >50-gap, no-4008 and denial tests guard those contracts. CPU/RSS, SQL counts, peak memory, natural cursor-stall frequency, latency distributions, production performance/capacity and an optimal cap were not measured or proven. Logs stayed outside Git; no raw artifacts or machine-local paths are published.

## Module-direction check cost (#80)

### #80 cost evaluation

- Source: [`docs/decisions.md` at 5023c62, line 82](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md#L82); added in 1b9abc5 (PR #89).
- Issue: #80. Decision: `docs/decisions/process.md` "Rules, CI and AI process (#80 cost)".

#80 cost evaluation (Rust 1.99.0, local macOS ARM64, Node 26.13.0): the exact `node scripts/check-module-direction.ts` step, with dependencies cached and `cargo clean -p fukulow-server` before each of three runs, had medians 1.74 s before / 1.68 s after (no measurable regression at this scale). The negative/positive fixture suite grew from 54 to 71 tests, 6.07 s / 7.48 s in single runs. New unstable surface: HIR binding visitation, `pat_ty`, `expr_ty_opt`, `Ty::walk`, `GenericArg::as_type` and `AdtDef::did`; existing typeck queries are reused, with no new rustc crate or application dependency. This is a small accepted maintenance increment: each toolchain bump must rebuild the driver, verify these APIs and run all fixtures plus production/test targets, including type-level array constants without body expression types. The root nominal-wrapper limit stays Tier 2.

## Topic projection paging feasibility (#137, 2026-11-11)

Target chosen before measurement: full in-process HTTP timeline-page p95 <=100 ms at concurrency 4, 50 items, both recent and deep W-relative boundaries. Query: aggregate immutable Messages <=W by Topic (min/max/count), union plain Messages, apply the exclusive boundary and descending LIMIT 51, then join only selected latest payloads/names; return ascending. Index: `messages (organization_id, channel_id, topic_id, seq)` plus the existing unique Channel/seq index. It does not establish page-size-bounded query work.

Reproduce with `DATABASE_URL` pointing at PostgreSQL 18.6: `cargo test --release -p fukulow-server --lib measure_topic_projection_pages -- --ignored --nocapture`. Committed probe: `server/src/messages/tests/topics/measurement.rs`; production query: `server/src/messages/topics/projection.rs`. Reproduction source: implementation 4c8d518 on base da8b9fc. Fresh SQLx database, production-sized 20-connection pool, native release Rust 1.99.0, current-thread Tokio, Apple M5/10 CPUs/32 GiB, macOS 27.0.1 arm64, Docker PostgreSQL 18.6 over loopback port 55432. No concurrent build, test suite or load probe; desktop/agent and other worktree/background processes were not isolated.

Dataset: one Organization/Member/public Channel, 10,000 Topics and 100,000 pre-W Topic Messages (10 per Topic), W=100000. All Topics receive one later Message (10,000 post-W Messages; committed seq=110000). Each pre-W Topic position is 90001..100000. No plain Messages in this cost probe; correctness tests separately cover mixed timelines. VACUUM ANALYZE Messages and ANALYZE Topics, 10 sequential warm-up requests per point, then 4 response-paced workers ×100 requests (400 samples). Recent: no boundary; deep: before_position=95001 (5,000 positions already consumed, equivalent to 100 full pages). Both requests pass as_of_seq=100000 and limit=50. Timings include authentication, preauthorization, watermark admission/barrier, snapshot query, serialization and response decoding; exclude TCP/proxy/TLS and fixture setup. Every response checks exact W/count/position.

| Boundary | Samples | p50 ms | p95 ms | max ms | Target |
|---|---:|---:|---:|---:|---|
| Recent | 400 | 35.323 | 64.806 | 88.482 | p95 <=100 ms: pass |
| Deep, exclusive 95001 | 400 | 24.703 | 37.373 | 67.434 | p95 <=100 ms: pass |

Nearest-rank p95 is sorted sample 380/400. This single warm-cache shared-host run supports feasibility at this dataset/concurrency only, not arbitrary history size, cold-cache performance, page-size-bounded work, mixed-Channel capacity or a production latency guarantee. No expiry or candidate limit was added.

### #137 round-1 mixed timeline and concurrent-send remeasurement (2026-11-11)

This supersedes the preceding feasibility evidence for the current decision; the earlier Topic-only/VACUUM run remains historical. Same preselected <=100 ms timeline p95 target, four response-paced readers, 50 items, recent and deep W-relative pages. Production now fixes/validates W under the #135 barrier, releases the watermark slot and shared lock, then runs the immutable-prefix aggregate in a fresh authorization/data snapshot. No new read admission or history/candidate limits.

Reproduce sequentially with DATABASE_URL pointing at the test PostgreSQL, and no concurrent builds/tests/load probes: `MEASURE_TOPICS=5000 cargo test --release -p fukulow-server --lib measure_topic_projection_pages -- --ignored --nocapture`, then the same command with `MEASURE_TOPICS=10000` (the default). Committed runner: `server/src/messages/tests/topics/measurement.rs`; round-1 changes on base 74c1e02. Native optimized Rust 1.99.0, current-thread Tokio, 20-connection application pool, fresh SQLx database per size, Apple M5/10 CPUs/32 GiB, macOS 27.0.1 arm64, Docker 29.9.3/PostgreSQL 18.6 over loopback port 55432. Desktop/agent/background work was not isolated.

At T=5,000/10,000 Topics, seed 10 pre-W Messages per Topic plus 50,000/100,000 plain Messages, interleaved at odd/even seq, W=100,000/200,000. Every Topic moves once after W, so initial Channel size is 105,000/210,000 Messages. Run ANALYZE only; no forced VACUUM. Ten sequential warm-ups per boundary, then four readers ×100 requests (400 samples). Deep boundary is exclusive 95,000/190,000: 5,001/10,001 timeline positions consumed (about 100/200 pages). Responses verify W, all 50 exact mixed positions, and each Topic count=10 despite later activity.

During each timed window a fifth worker sends real HTTP Topic Messages to the same Channel/Topic every 50 ms (20/s nominal, first tick immediate); each send awaits its response, missed ticks are skipped. Actual rates below show no material offered-rate loss in these windows. Timings cover in-process HTTP authentication, authorization, barrier, query, serialization/decoding; send timings include persistence/COMMIT/ACK, not WebSocket receipt. They exclude fixture setup, TCP/proxy/TLS. Nearest-rank percentiles: reads sample 380/400; sends ceil(0.95×N).

| Initial Channel Messages | Boundary | Read N | Read p50 / p95 / max ms | Send N | Send p50 / p95 / max ms | Window s / sends per s |
|---:|---|---:|---|---:|---|---|
| 105,000 | Recent | 400 | 16.598 / 20.819 / 37.401 | 36 | 5.168 / 21.147 / 22.801 | 1.761 / 20.437 |
| 105,000 | Deep, exclusive 95,000 | 400 | 17.961 / 23.995 / 28.950 | 38 | 5.293 / 8.173 / 9.011 | 1.878 / 20.229 |
| 210,000 | Recent | 400 | 28.696 / 32.342 / 52.591 | 59 | 5.043 / 11.249 / 19.983 | 2.927 / 20.154 |
| 210,000 | Deep, exclusive 190,000 | 400 | 28.619 / 32.235 / 38.311 | 59 | 4.776 / 6.345 / 8.638 | 2.924 / 20.177 |

Both sizes/boundaries pass. The smaller Channel gained 74 Messages and the larger 118 over their two timed windows. A deliberately simple proportional projection from the larger point's worst read p95 crosses 100 ms at 210,000 ×100/32.342 ≈649,310 total Channel Messages (about 30,920 Topics, 618,390 pre-W mixed Messages at the same ratio). Treat ~649k as the planning stop-and-remeasure point; it is not a measured failure or safe capacity bound. Plan changes, heap visibility, cache pressure and contention can invalidate linear scaling; these single, short, warm-cache shared-host runs do not establish arbitrary-history, cold-cache or production performance. The smaller point is a scaling check, not a fitted capacity guarantee. No limits were added. Raw logs outside Git: `/private/tmp/topics-137-release-{5000,10000}.log`.

## Reply chain indexed paging (#139, 2026-11-11)

Target chosen before measuring: local warm full in-process HTTP p95 <100 ms for a 200-Message page, for both a 10,000-deep and a 10,000-wide Reply chain. Four response-paced readers, first/middle/final pages; no depth cap. Keep the stored root and indexed range approach: all six measured points pass.

Reproduce: `DATABASE_URL` pointing at an isolated PostgreSQL 18.6 instance, then `cargo test --release -p fukulow-server --lib measure_reply_chain_pages -- --ignored --nocapture`. Probe: `server/src/messages/tests/replies/measurement.rs`; query: `server/src/messages/replies.rs`; migration: `202611110198_replies.sql`; base c20b436. Native optimized Rust 1.99.0, current-thread Tokio, 20-connection application pool, fresh SQLx database, Apple M5/10 logical CPUs/32 GiB, macOS 27.0.1 arm64, Docker PostgreSQL 18.6 over loopback port 55439 (trust-auth test container). No other test/build/load work launched by this task during timed requests; unrelated desktop/worktree activity was not isolated, and another Cargo build was observed near probe start.

Dataset: one Organization/Member/public Channel, no Topic. Each chain has one root and 10,000 descendants, stored via SQL fixture setup. Deep: each Reply points to its predecessor (10,000 edges). Wide: every Reply points directly to the root. Ten unrelated non-Reply Messages follow each chain entry, so deep has 110,011 Channel Messages; wide is added in the same Channel for 220,022 total. All seq positions are populated. Roots have null reply_root_id; every descendant stores the root. Body is `measurement` (unrelated body `unrelated measurement`). ANALYZE only, no forced VACUUM or planner settings. A dense-only pilot chose the existing Channel/seq index; interleaving unrelated Messages tests the sparse-chain index path without forcing an index.

Every request anchors at the deepest/last descendant, resolves its root by scoped id, and returns limit=200. First/middle/final requests pass after_seq = offset + 11k, where k=0/5000/9801 and offset=0 for deep, 110011 for wide. Ten sequential warm-ups per point, then four readers x100 requests (400 samples; 2,400 total). Each response verifies root, page length, exact first/last seq and has_more (true/true/false). Nearest-rank p95 = sorted sample 380/400. Timings include authentication, preauthorization, watermark admission/barrier, fresh snapshot authorization, anchor lookup, page query, serialization and response decoding; exclude fixture setup and TCP/proxy/TLS. No concurrent sends in this cost probe; correctness tests cover appends between pages.

| Shape | Consumed chain entries k | Channel Messages | p50 ms | p95 ms | max ms | Target |
|---|---:|---:|---:|---:|---:|---|
| Deep | 0 | 110,011 | 5.188 | 8.490 | 14.694 | <100 ms: pass |
| Deep | 5,000 | 110,011 | 4.841 | 6.243 | 13.886 | <100 ms: pass |
| Deep | 9,801 | 110,011 | 5.066 | 8.103 | 12.161 | <100 ms: pass |
| Wide | 0 | 220,022 | 4.989 | 9.503 | 29.957 | <100 ms: pass |
| Wide | 5,000 | 220,022 | 4.852 | 7.164 | 11.944 | <100 ms: pass |
| Wide | 9,801 | 220,022 | 4.897 | 7.788 | 14.620 | <100 ms: pass |

EXPLAIN (ANALYZE, BUFFERS) after each point uses messages_channel_id for the root point lookup and messages_reply_chain_seq for the descendant range. The range emits only 200/201/200 rows, with zero filtered-out descendants; no recursive traversal. The page plan hits 13-16 shared buffers, reads zero blocks, and takes 0.106-0.148 ms. The separate anchor query uses the scoped unique id; it never follows parent links. These short, shared-host warm-cache runs support page-size work for the observed plans, not arbitrary history size, cold-cache/maximum-body performance, planner stability or production capacity. No truncation, expiry, depth cap or dependency was added. Raw logs outside Git: `/private/tmp/replies-139-measure-sparse.log`.

### Final-source validation-precedence recheck (#139)

After adding DeferredOrganizationAuth (same session query, with Organization denial deferred until validation), reran the identical committed probe on the same isolated PostgreSQL port and dataset. All six points still pass the preselected <100 ms target. No other suite/build was launched by this task during timed requests; shared-host background work remains uncontrolled, so the difference from the preceding run is not a controlled regression comparison or evidence of extractor cost.

| Shape | Consumed chain entries k | p50 ms | p95 ms | max ms |
|---|---:|---:|---:|---:|
| Deep | 0 | 13.196 | 28.857 | 67.563 |
| Deep | 5,000 | 11.881 | 29.778 | 47.911 |
| Deep | 9,801 | 12.488 | 34.693 | 50.640 |
| Wide | 0 | 9.297 | 17.585 | 28.329 |
| Wide | 5,000 | 10.040 | 19.482 | 47.250 |
| Wide | 9,801 | 8.945 | 14.606 | 25.853 |

All six plans still use the scoped root index and messages_reply_chain_seq; the range emits at most 201 rows with no descendant filter removals. Same 400 samples per point, warm-ups, exact response assertions and limitations as above. Raw log: `/private/tmp/replies-139-measure-final.log`.

### Partial-index review recheck (#139)

After merging #207 and making messages_reply_chain_seq partial (WHERE reply_root_id IS NOT NULL), reran the same release probe and exact dataset above on a fresh isolated PostgreSQL 18.6 Docker instance, random loopback port 55413. Source: f535341 plus the origin/main d1d5aaf merge and review fixes. Same hardware/software, 20-connection pool, four readers, ten warm-ups and 400 samples per point. No other builds/tests/load probes from this task ran during timed requests; shared-host activity remains uncontrolled. Earlier records remain historical; this is not a controlled performance comparison.

| Shape | Consumed chain entries k | p50 ms | p95 ms | max ms |
|---|---:|---:|---:|---:|
| Deep | 0 | 4.823 | 7.698 | 11.394 |
| Deep | 5,000 | 4.824 | 7.749 | 13.957 |
| Deep | 9,801 | 4.837 | 7.534 | 12.291 |
| Wide | 0 | 4.906 | 8.483 | 14.684 |
| Wide | 5,000 | 4.863 | 6.927 | 10.550 |
| Wide | 9,801 | 5.069 | 7.819 | 16.759 |

All six points pass the unchanged <100 ms target. EXPLAIN (ANALYZE, BUFFERS) confirms messages_org_channel_id_key for the root and the partial messages_reply_chain_seq for descendants at every point, without forcing the planner. Descendant ranges emit 200/201/200 rows with zero filter removals; page plans hit 12–17 shared buffers, read zero blocks and take 0.117–0.199 ms. Keep the partial index: it serves the chain query while excluding non-Replies. Same warm-cache and production-capacity limits as above. Raw log outside Git: /private/tmp/replies-139-review-measure.log.

## Graceful shutdown and reconnect storm (#195, 2026-11-11 JST)

- Decision: retain 60 s overall drain / 75 s Compose grace; spread reconnect attempts with client full jitter. Source: c3f782b plus the #195 working-tree patch (production source and harness snapshots in artifacts). Docker release build, Rust 1.99.0, PostgreSQL 18.6, k6 1.8.2; Apple M5, 10 cores, 32 GiB, Docker Desktop 29.9.3 VM with 10 CPUs / 7.748 GiB. Pilot/initial runner Node 26.8.1; final runner and all image builds use pinned Node 26.13.0. Direct Docker-network HTTP, no TLS/proxy, one public Channel/Account/Member, fresh isolated DB, sequential runs. A small pilot validated the harness; both 10,000-socket runs had no concurrent test suite or publishing during restart.
- Reproduce: `LOAD_RECONNECT_STORM=1 LOAD_DIRECT_NETWORK=1 CHANNELS=1 SUBSCRIBERS=10000 SOCKETS_PER_SESSION=500 CONNECT_BATCH=100 CONNECT_INTERVAL_MS=100 PUBLISHERS=1 DURATION_SECONDS=3 PUBLISH_INTERVAL_MS=500 READY_TIMEOUT_SECONDS=120 DRAIN_TIMEOUT_SECONDS=30 make load-record`. Twenty sessions share 500 sockets each; descriptors 65,536, request timeout 45 s. Once all sockets subscribe, the runner sends SIGTERM by restarting only its isolated app; the generator uses the web client's full-jitter function, resets on `subscribed`, and resumes each gap-free cursor. Six 17-byte sends follow full recovery, expecting 60,000 deliveries. The 20-socket pilot used one session, one connect batch, readiness/drain timeouts 90/15 s; other publishing settings match.

| Sockets | All subscriptions recovered ms | Attempt count | Reconnect attempt ms min / median / p95 / p99 / max | First 1001 observed ms min–max | Docker restart command ms |
|---|---:|---:|---|---|---:|
| 20 pilot | 1,291 | 25 | 94 / 361 / 1,036.6 / 1,078.24 / 1,084 | 75–76 | 279 |
| 10,000 initial | 7,362 | 13,392 | 83 / 587 / 3,977 / 4,454 / 7,354 | 64–314 | 535 |
| 10,000 pinned repeat | 3,410 | 11,625 | 77 / 494 / 1,000 / 1,312.76 / 2,440 | 69–293 | 461 |

- Times start at the generator's restart trigger, before host command dispatch. Attempt distributions include every retry, not just the random sleep or successful reconnect. Close observations include generator scheduling/network time; Docker command time includes stop and startup, not a server-only drain measurement. The initial 10,000-socket run received exactly 10,000 shutdown 1001 frames, then transient 2,179 abnormal 1006 and 1,213 internal 1011 closes while reconnecting; zero 4008, missing deliveries, sequence gaps, load errors or send rejections. All six sends and 60,000 deliveries succeeded in each 10,000-socket run. The pinned repeat observed 10,000 shutdown 1001 and 1,625 transient 1006, no 1011/4008 or missing deliveries. The pilot had five transient 1006 and no 1011, with 120/120 deliveries. Transient failures are visible rather than treated as proof of loss; the existing per-Channel watermark admission budget limits this popular-Channel storm.
- Limits: one pilot and two 10,000-socket samples with different host runner Node versions, shared machine, k6 rather than a browser, small bodies, no traffic until subscriptions recover, no saturation of in-flight sends during this load run. No deterministic-backoff baseline or performance-improvement claim. SQL/resource snapshots span restart/replay plus publishing, so SQL/send ratios are not steady-state send costs. Controlled real-SIGTERM tests separately hold a pre-COMMIT send and detached notification, verify drain completion and short deadline expiry, then retry identical keys and replay without gaps. The 40 s admitted-send bound plus 10 s notification deadline leaves 10 s margin within 60 s; pre-admission authorization can exceed that work budget, so the overall deadline remains the unconditional escape hatch. Measurements support retaining provisional values, not a universal worst-case bound.
- Artifacts outside Git: `/private/tmp/fukulow-195-storm-20`, `/private/tmp/fukulow-195-storm-10000` and `/private/tmp/fukulow-195-storm-final-10000` hold metadata, image IDs, reconnect/Close samples, k6 metrics, SQL/resource snapshots and server logs. The final run was repeated with pinned Node and a complete source patch including newly added files; its source snapshot is authoritative for reproduction. The runner removed its containers, network, volume and uniquely tagged image after each run.

### #195 round 1 concurrent-send SIGTERM drain (2026-11-11 JST)

- Decision evidence: retain provisional 60 s overall drain / 75 s Compose grace. Three release probes drained in **777.360 / 813.652 / 804.816 ms** (median 804.816 ms, observed maximum 813.652 ms). This adds an in-flight-send measurement to the idle restart evidence above; it is not a universal upper bound or a before/after performance comparison.
- Source: 47673cd plus the PR #207 round-1 review fixes. Rust 1.99.0 native macOS arm64 release test binary, Apple M5 / 10 CPUs / 32 GiB; PostgreSQL 18.6 in a disposable Docker container, isolated random loopback port and fresh SQLx test database per run. Shared development host; no other validation suite from this worktree ran during the three timed probes. Direct loopback HTTP and Docker-published PostgreSQL, no TLS/proxy, production 20-connection application pool and admission/deadline settings.
- Reproduce with DATABASE_URL pointing to an isolated PostgreSQL 18.6 administrator database: run `cargo test --release -p fukulow-server --lib measure_sigterm_under_concurrent_sends -- --ignored --nocapture` three times. The parent sends real SIGTERM only after the child reports readiness. Establish 2,048 HTTP connections before the burst to avoid the host listen-backlog limit; send 13-byte bodies across eight public Channels in one Organization/Account Session. Pause each Channel's first transaction before COMMIT and wait for the work counter to reach 2,048: eight in-flight transactions and 2,040 queued sends. Release all eight gates immediately when shutdown begins; no artificial wait is added to the measured drain.
- Time starts when the real signal future resolves and ends when `serve` returns, including HTTP completion, detached persistence/notification and socket drain, and pool close; connection preparation, parent signal dispatch and replay verification are excluded. All three runs completed every HTTP request with 201, observed shutdown Close 1001 on the socket subscribed to all eight Channels, closed the pool and replayed all 2,048 canonical Messages in per-Channel sequence order with no duplicates or gaps.
- Limits: a native release test harness using the production router/drain, not the deployed main-process exit/runtime teardown or Compose SIGKILL path; one small-body Organization burst and one socket, not 10,000 subscribers during publishing. Gates establish the backlog but release immediately on signal, so this does not exercise prolonged COMMIT/notification stalls, admission expiry, pre-admission authorization/pool contention or a slow database. The 60 s application escape hatch / 75 s supervisor grace have substantial headroom over these samples; their worst-case sufficiency remains provisional because pre-admission SQL can exceed the work budget. Raw run logs remain outside Git at `/private/tmp/fukulow-207-send-drain-{1,2,3}.log`.

## Backup restore drill (#198 C)

Initial drill (2026-11-11 JST, #198 C): **1.82 seconds**, on Apple M5/arm64 macOS, Docker 29.9.3 with 10 CPUs / 8,319,438,848 bytes VM memory, Node 26.13.0, cached `postgres:18` = PostgreSQL 18.6 (`sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722`). A fresh, separately named Compose source had all 9 repository migrations, 2 Organizations, 1 Account, 2 Members with owner/guest Roles, 2 public/private Channels and grants, 2,000 synthetic Messages (seq 1–1,000 per Channel), and 3 Account Sessions. `node scripts/backup.ts` produced a 133,556-byte archive; `node scripts/restore-drill.ts` restored it with constraints, ended all Sessions and passed heap/index checks in a separate network-disabled tmpfs container, then removed it. This tiny synthetic dataset, cached image and memory-backed destination do not estimate VPS disk restore time or a full production outage. The source retained its original 2,000 Messages and 3 Sessions.

## Channel-list Unread read-position ranges (#142 review B1, 2026-11-11)

Compare the reviewed initial-seq aggregate with the production read-position query after merging main d1d5aaf. Reproduce using an isolated PostgreSQL 18.6: `DATABASE_URL=<throwaway database> cargo test --release -p fukulow-server --lib measure_unread_list_read_position_ranges -- --ignored --nocapture`; repeat with `MEASURE_HISTORY=5000` (default 50000). Committed probe: `server/src/messages/tests/unread/measurement.rs`, including the old SQL comparator; production: `server/src/messages/unread.rs::LIST_COUNTS_SQL`. No concurrent build, test suite, writer or load probe during either timed run. Native release Rust 1.99.0, Apple M5/10 CPUs/32 GiB, Darwin 27.0.0 arm64, Docker 29.9.3/PostgreSQL 18.6 over loopback port 55442, tmpfs database; desktop/background work was not isolated.

Shape: one Organization, two Members, 20 public Channels, 10 Topics per Channel (200 total). Each Channel has 5,000 or 50,000 immutable Messages, half plain (even seq), half evenly distributed across Topics (odd seq); all sent by the other Member. Total history is 100,000 or 1,000,000 Messages. There are 40 Channel positions, 200 explicit viewer Topic positions and 20 counters. Viewer initial_seq remains 0. Both Channel and Topic read positions are set to history size (fully read), then history size minus 100 (2,000 unread total: 1,000 plain plus 1,000 Topic Messages). Topic last_seq/counts match the fixture. ANALYZE all five query tables, without forced VACUUM or planner settings. Existing `messages_topic_seq (organization_id, channel_id, topic_id, seq)` supplies both range scans; no additional index is needed.

Each query/shape gets five sequential warm-ups then 50 response-paced samples on one SQLx connection pool, before then after; nearest-rank p95 is sample 48/50. Timings include pool acquisition, the count query over loopback and SQLx row decoding, excluding fixture setup, authentication, the separate visible-Channel query and HTTP/proxy/TLS. Every sample checks all 20 positions and exact plain/total counts. These are query timings, not endpoint latency or a concurrency capacity claim.

| History rows | Unread rows | Before p50 / p95 ms | After p50 / p95 ms |
|---:|---:|---:|---:|
| 100,000 | 0 | 17.320 / 18.323 | 0.602 / 0.731 |
| 100,000 | 2,000 | 17.358 / 18.053 | 0.987 / 1.065 |
| 1,000,000 | 0 | 162.140 / 174.414 | 10.559 / 11.157 |
| 1,000,000 | 2,000 | 204.778 / 255.727 | 13.773 / 14.202 |

EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON), captured after each sample window: before at 1M rows uses a Message Seq Scan (1,000,000 actual rows) with joins and grouped counts even when fully read; execution 272.273 ms fully read / 312.079 ms with the tail. After uses lateral aggregates and parameterized `messages_topic_seq` Index Scans with organization/channel/topic equality and `seq > read position`. Fully read: main scan 20 loops ×0 rows; Topic Message scan never executes (0 loops), because last_seq rejects all 200 Topics. Tail: main scan 20×50 rows, Topic scan 200×5 rows, exactly 2,000 Message rows total; no history filtering. Explain execution 9.962 / 12.322 ms. The small 200-row Topics table uses sequential scans per Channel (20×200 candidates), with 10 matching Topics per Channel; this is separate from Message history work.

Limits: at 1M rows the planner's conservative range estimates trigger JIT (69 functions, ~9.7/11.0 ms compilation in the two after plans), whereas the 100k after plans do not. Thus latency is not constant across history sizes despite eliminating reads of already-read Messages. This focused warm-cache comparison supports O(unread-range Messages + Channel/Topic lookup work), not arbitrary-history latency, cold-cache, many-Topic, simultaneous reconnect or production performance. Own Messages in unread ranges still require filtering. Raw plans/results remain outside Git at `/private/tmp/unread-142-measure-{5000,50000}.log`; older records above are unchanged.

Reproduce with the dataset and cached image above: follow [deployment: Operations](spec/deployment.md#operations-backup-and-restore-198-c), run `node scripts/backup.ts /absolute/private/backup-directory` in the separately named source Compose project, then `node scripts/restore-drill.ts /absolute/private/backup-directory/fukulow-EXAMPLE.dump`.

The measured drill time covers container startup, restore, ending Sessions and heap/index checks only. It excludes backup creation, download/image pull, incident detection, finding the right archive, permission reconciliation, database switch, app restart, client checks and human approval. Production dataset size, disk, CPU, contention and failure modes differ; measure a representative drill on the recovery hardware before estimating outage duration. No measured drill time is a guaranteed recovery deadline.

## Web Unread retained records (#272, 2026-11-12 JST)

Compare the same production Unread controller with retention disabled (`before`, only `needsUnreadRecord` replaced by always-true) and enabled (`after`). Probe: `web/src/unread-memory.test.ts`, skipped by default. From the repository root, run these separately, without concurrent tests/builds:

```bash
MEASURE_UNREAD=before npm --prefix web test -- src/unread-memory.test.ts --execArgv=--expose-gc --reporter=verbose --disableConsoleIntercept
MEASURE_UNREAD=after npm --prefix web test -- src/unread-memory.test.ts --execArgv=--expose-gc --reporter=verbose --disableConsoleIntercept
```

Conditions: main 706bb18 plus #272 working-tree changes, including PR #273 round-1 pruned-floor recovery and collect-order fixes. This rerun replaces the earlier measurement in this same unmerged PR. macOS 27.0.1 / Darwin 27.0.0 arm64, Apple M5, 10 CPUs, 32 GiB; Node v26.8.1 (local runtime, repository pin is 26.13.0), Vitest 5.1.0, default fork pool. One watched Channel, main plus Topics T/U, 100,000 distinct other-sender Messages. Bootstrap Message 1 is main; subsequent even seq are main, odd seq alternate T/U. Upstream sync retains only the current Message; projection history is empty with full coverage. Every 1,000 Messages, refetched Channel and Topic baselines advance all persisted positions to the current seq with zero counts. No visit, pending mark or HTTP retry is active. The real controller collects, merges baselines, prunes and computes snapshots; only upstream observations and HTTP results are deterministic doubles. Both modes assert zero aggregate Unread after each refresh. No per-Message mock call log or full history array is retained.

Each process warms one controller first, takes its starting `process.memoryUsage().heapUsed`, then samples after every 25,000 Messages and all baseline refreshes. `global.gc()` runs before every heap sample (`gc:true` in both runs). Starting heaps: before 11,258,072 bytes; after 11,258,816 bytes. Recorded results:

| Messages | Records before / after | Heap growth before / after (bytes) |
| --- | --- | --- |
| 25,000 | 25,000 / 0 | 5,864,072 / 338,392 |
| 50,000 | 50,000 / 0 | 11,410,048 / 359,600 |
| 75,000 | 75,000 / 0 | 17,864,808 / 381,352 |
| 100,000 | 100,000 / 0 | 22,494,176 / 395,688 |

Peak retained records: 100,000 before, 1,000 after. At 100,000 Messages, absolute post-GC heaps were 33,752,248 / 11,654,504 bytes (growth 21.452 / 0.377 MiB). This supports retaining the active baseline/aggregate/visit windows rather than all collected session history.

Limits: one deterministic process run per mode; heap includes controller metadata, Topic baseline identity bookkeeping and the test runtime, so it is not a per-Message byte estimate or an allocation/latency benchmark. Upstream sync and Topic caches, browser rendering and network scheduling are excluded. Baselines refresh every 1,000 Messages here; missing/stale scope baselines, a held aggregate or a long visit intentionally retain wider windows. The bound depends on those windows, not a fixed record cap. Separate regression tests cover baseline subtraction after local reads, held Topic positions, unresolved and advancing visits, duplicate replay, and seeded equivalence with shared events and out-of-order/backward baselines (pruned counts may be null until a post-position refetch recovers). Shared contract fixtures are unchanged.

## RLS baseline before tenant RLS (#314 step 2, 2026-11-12)

- Purpose: the "before" side for #314 step 5 (same harness, dataset and plans after RLS). Source: main f11ba03, clean tree, no RLS policies. Apple M5, 10 CPUs, 32 GiB; Docker Desktop 29.9.3 VM 10 CPUs / 7.748 GiB; PostgreSQL 18.6 (image e3d24f69…, defaults: shared_buffers 128MB, work_mem 4MB); k6 1.8.2; host Node 26.13.0; Rust 1.99.0 release image. Shared machine, no other suite or AI worker running.
- Load reproduce: `CHANNELS=1 SUBSCRIBERS=20 PUBLISHERS=2 PUBLISH_INTERVAL_MS=100 DURATION_SECONDS=30 READY_TIMEOUT_SECONDS=15 DRAIN_TIMEOUT_SECONDS=10 LOAD_RESULT_DIR="$LOAD_ARTIFACTS" make load-record`, three sequential runs, fresh isolated DB each, app connects as `fukulow_app`.

| Run | Sends (accepted) | Deliveries / missing / errors | Delivery ms median / p95 / p99 / max | Send HTTP ms median / p95 / p99 | Top-level queries per send | Peak CPU app / db % |
|---|---:|---|---|---|---:|---|
| 1 | 600 (600) | 12,000 / 0 / 0 | 8 / 13 / 16 / 46 | 7 / 11 / 13 | 9.008 | 6.49 / 10.95 |
| 2 | 600 (600) | 12,000 / 0 / 0 | 9 / 12 / 16 / 50 | 7 / 11 / 13 | 9.008 | 6.90 / 12.62 |
| 3 | 600 (600) | 12,000 / 0 / 0 | 9 / 13 / 17 / 47 | 7 / 11 / 14 | 9.008 | 6.91 / 12.96 |

- All 1,244 checks passed in each run; 13.035 statements per send including BEGIN/COMMIT and nested. Highest total SQL time per run: Message INSERT, sequence upsert, session AUTH, fan-out `member_access`.
- Plans reproduce: fresh PostgreSQL 18.6, `sqlx migrate run`, `deploy/db-roles.sql` + `deploy/db-grants.sql`, then `psql -f load/hot-plans/seed.sql` as owner and `psql -X [-v generic=1] -f load/hot-plans/plans.sql` as `fukulow_app` six times per mode; medians of passes 2–6. Without `generic`, the `auto.*` sections run timeline and Unread counts six more times in the same session, then explain under default `plan_cache_mode`. Dataset: Org A 10,000 Members (every 50th a guest), 40 public + 10 private Channels, measured Channel 100,000 Messages (70% in 2,000 Topics), 2,000 Messages elsewhere; Org B 1,000 Members, 10 Channels × 5,000; 406,800 Channel read positions at the last 100 Messages; the measured Member also has all 2,000 Topic positions at that cut-off (hot-Channel Unread 100). Writes rolled back.

| Query (Execution Time, ms) | Custom plan | Forced generic |
|---|---:|---:|
| AUTH session lookup | 0.024 | 0.025 |
| Visibility check (VIS) / watermark shared lock / watermark | 0.020 / 0.012 / 0.008 | 0.022 / 0.018 / 0.008 |
| Send: Member FOR SHARE / Channel public / idempotency lookup / reply parent | 0.021 / 0.005 / 0.012 / 0.041 | 0.024 / 0.006 / 0.022 / 0.039 |
| Send: Channel advisory lock / sequence upsert / Topic join / Topic id | 0.006 / 0.049 / 0.042 / 0.007 | 0.008 / 0.053 / 0.039 / 0.009 |
| Send: Message INSERT / Topic record | 0.197 / 0.035 | 0.196 / 0.035 |
| History latest page / old page (51 rows) | 0.033 / 0.036 | 0.037 / 0.036 |
| Timeline latest page (51 of 2,000 Topics) | 37.659 | 144.048 |
| Timeline single Topic | 0.137 | 7.921 |
| Replay 50 after cursor | 0.053 | 0.060 |
| Fan-out `member_access`, 1,024 candidates / `access_rows`, 1,024 subscriptions | 0.978 / 2.442 | 1.077 / 2.568 |
| Unread: visible Channel list / counts for 50 Channels | 0.624 / 20.623 | 0.704 / 3.973 |
| Mark-read: position FOR UPDATE / Channel update / Topic exists / Topic upsert | 0.014 / 0.043 / 0.013 / 0.029 | 0.011 / 0.035 / 0.013 / 0.028 |

- Default `plan_cache_mode` (what SQLx's cached statements get) used the generic plan after the repeated executions: timeline 141.150 ms (range 140.588–141.706) with 644,699 shared-buffer hits (custom: 5,566) via Incremental Sort + GroupAggregate over all 70,000 Topic Messages; Unread counts 3.868 ms (3,814 hits, same as custom). Step 5 compares custom, generic and `auto.*`. Tracked in #326.
- Limits: single machine, one dataset shape, warm cache, single-session EXPLAIN without concurrency; EXPLAIN timing overhead included; small-load run only (20 sockets), not capacity. Not a guarantee. Raw outputs stay outside Git in `/private/tmp/fukulow-314-baseline` (plans in `v2/`; load artifacts hold server logs and a source patch: do not attach publicly).
