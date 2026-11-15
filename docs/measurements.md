# Measurements

Writing: only results behind a decision, performance comparisons or key regression checks, with reproduction conditions and limits; no routine/debug logs, raw artifacts or duplicates; never silently rewrite or drop an old record.

Past measurement records: values, conditions, compared targets, methods, limits and commits. Evidence only: nothing here is a performance, capacity or latency guarantee of `docs/spec.md`. Current decisions drawn from these records live in `docs/decisions.md`.

How to use: do not read this file whole. Search the Issue number or topic and read that section only, when doing performance work, load tests, regression investigation or comparing results.

Rules for new records: keep results that affect a design decision, performance comparisons and important regression investigations; no routine test logs or debug output. State the conditions needed to reproduce and the limits. Do not commit large raw logs or artifacts. Do not compare runs with different methods or environments as a simple improvement rate. When a new measurement contradicts an old one, add it beside the old record with its conditions; never silently rewrite or delete the old record. One measurement is recorded once.

Record text is copied verbatim from its source line(s) (values and conditions unchanged). Raw logs, artifact directories and `/private/tmp` paths named in records were kept outside Git; they are not in this repository and may no longer exist, so they cannot be restored from here.

## Search engine comparison (#153, 2026-11-15 JST, preliminary, Mac)

This is a **relative preliminary comparison on a Mac**. Production Linux performance is unverified; the formal **p95 <= 500 ms** judgement is on Linux later. No formal performance pass is declared. The target remains 1,000,000 Messages and 5 concurrent searches, with a 180-day search range.

Reproduce from the repository root, with Docker running and Node **26.13.0** active: `node load/search-engines/run.ts`. It builds one measurement-only image, creates an isolated container with a random local password and no published ports, runs the comparison, writes artifacts outside Git, and removes its container/volume. `SEARCH_RESULT_DIR` optionally selects a fresh external output directory; its parent must exist, and an existing output directory is rejected before any artifacts are written. The recorded cohort uses `/private/tmp/fukulow-search-153-cohort/`; source is `21e1fa84` plus this harness. Raw pgbench logs/reports, SQL, full plans, seed/query metadata, small dumps, result JSON and source hashes stay there. Earlier incomplete setup/verification attempts are excluded.

Conditions: Mac model identifier **Mac17,2**, Apple M5 / 10 CPUs / 32 GiB, macOS 27.0.1 arm64; Docker 29.9.3, VM 10 CPUs / 7.748 GiB. Node 26.13.0 orchestrates container-local PostgreSQL 18.6 pgbench over Unix sockets. No HTTP, TLS, proxy, API authorization round trips or WebSockets. No other load test, build or test suite runs during timing; desktop activity continues. Guest filesystem caches are retained, so this is not a cold-storage test.

The common image starts from the repository's pinned `postgres:18.6@sha256:e3d24f69…`. PostgreSQL server/client/development headers remain **18.6-1.pgdg13+2**; pg_trgm is bundled; pg_bigm is built from official release tag **v1.2-20250903**, archive SHA-256 `4d4fb48161e3f9e99207851299379c83b3e5d1d3c1a07c35f6a3153d577b3142`; PGroonga **4.1.0-1** and libgroonga0 **16.1.3-1** come from the official Groonga APT repository. These are measurement-only dependencies, needed to compare Japanese/short-substring indexes; they do not approve a production dependency.

Every condition uses shared_buffers 128MB, work_mem 4MB, maintenance_work_mem 64MB, effective_cache_size 4GB, random_page_cost 4, max_connections 100, max_worker_processes 16, container shared memory 1GB; JIT, fsync and synchronous_commit on; WAL level replica. PGroonga's WAL resource manager and primary crash-safer are preloaded for **all** variants, including the no-search-index control, with `pgroonga.enable_wal_resource_manager=on` and `pgroonga.enable_crash_safe=on`. The legacy `pgroonga.enable_wal` is not enabled. This includes PostgreSQL WAL costs for PGroonga rather than comparing its default no-WAL mode against durable GIN writes. Recorded settings/package versions are in metadata.json.

Data: seed **153202611**, original synthetic business-chat phrases mixed with kana/kanji/ASCII and deterministic identifiers, not a copyrighted corpus. Exactly **1,000,000 Messages**, 3 Organizations (approximately 60/25/15%), 40 Channels per Organization (half public/private), a 20% hot-Channel bias, and 8 Topics per Channel. **755,926** Messages have Topics; **199,973** are Replies, inheriting their root's Topic. Body scalar-length p50/p95/p99 is **155/676/754**, with a long-message bucket around 1,800 characters. **100,001** Messages are older than 180 days; three records straddle the exact boundary by -1/0/+1 second. The frozen search clock is **2026-11-15 00:00:00 UTC**, with both lower/upper timestamp bounds. The measured migration schema has no DM kind/participation schema, so no DMs are generated.

All existing migrations and app-role/grant SQL are applied. A measurement-only stored normalized_body column and common `(organization_id, channel_id, created_at DESC, id DESC)` B-tree support every variant. Only the search index differs: pg_trgm GIN, pg_bigm GIN or PGroonga. Each condition clones the same seeded base before installing/initializing PGroonga; live Groonga files are not copied through TEMPLATE. A serial `pgroonga_command('status')` runs before concurrent clients after restart. Copying initialized Groonga files in an excluded setup attempt caused an invalid-keys-table error; the runner avoids that lifecycle.

Normalization is **NFC -> Unicode default case folding -> NFC**, using PostgreSQL 18's casefold with builtin PG_UNICODE_FAST, then deterministic C collation for substring comparison. Full case folding handles non-ASCII letters and expansions such as Straße/STRASSE; lower under C would not meet that requirement. Queries trim Unicode White_Space at their edges, matching Rust str::trim; internal whitespace and BOM remain. Scalar counts are taken after normalization. LIKE escapes `%`, `_` and `\` as literals. Every engine indexes that same stored form. PGroonga disables its additional normalizer and uses TokenNgram with unify_alphabet/unify_digit/unify_symbol false: its defaults would introduce different normalization and miss internal ASCII partial matches ([normalization/case folding](https://www.postgresql.org/docs/18/functions-string.html), [PGroonga index configuration](https://pgroonga.github.io/reference/create-index-using-pgroonga.html)).

Method: engine order is control/trgm/bigm/PGroonga, then bigm/PGroonga/control/trgm, then PGroonga/trgm/bigm/control. Each gets a fresh clone, timed index build and DB restart. Only the three indexed variants get one identical complete query warm-up sweep and search samples; the control gets neither. For each indexed variant, each of 28 query classes then runs 5 clients × 20 prepared transactions: **100 samples/class/repetition**, including BEGIN, transaction-local set_config, query and COMMIT. Timed searches use non-owning NOSUPERUSER/NOBYPASSRLS fukulow_app with current Organization context; Account context remains unset, as in Organization helpers. Visibility is materialized from active Member Role/current-revision grants before per-Channel lateral reads; current non-Guests can read public Channels, private Channels and Guests require grants. The actor sees 24/40 Channels. Each Channel contributes at most its newest 20 hits, followed by global newest-first 20, ordered by created_at/id descending. Plans and completeness checks run after query timing, outside latency samples.

For writes, all variants reserve the same hot Channel sequence and INSERT a Message with FK checks, normalization and COMMIT: 50 warm-up inserts, CHECKPOINT, then 5 writers × 200 committed inserts. Reported WAL is cluster LSN growth / 1,000 inserts, including full-page images after that checkpoint. This is an isolated insert/sequence workload, not complete send API throughput or sustained mixed read/write load. GIN uses default fastupdate/pending-list settings. Synthetic historical Message UUIDs are deterministic and ordered; new measured insert UUIDs are random, so write/index locality is workload-specific.

Results: 12 completed conditions, 3 repetitions per variant, **25,200 timed searches** and **12,000 timed inserts**. The cohort ran **11:28–13:02 JST**. Each table reports the median of the three per-run values; brackets are min–max across repetitions, not confidence intervals. Each search percentile is independently medianed from 100 samples/run (300 samples/class/engine overall). p99 has limited tail precision. Aggregate statistics and all percentile ranges remain in summary.json; full per-run logs are under the round directories.

| Variant | Search index MiB, median [range] | Build seconds, median [range] | SQL inserts/s, median [range] | Write p50 / p95 / p99 ms | Write p95 range ms | PostgreSQL WAL bytes/insert, median [range] |
|---|---:|---:|---:|---:|---:|---:|
| Control (no search index) | 0.000 [0.000–0.000] | — | 5507.4 [5475.3–5515.1] | 0.790 / 1.457 / 2.319 | 1.371–1.488 | 9352.5 [9334.3–9368.3] |
| pg_trgm GIN | 224.016 [224.016–224.125] | 17.868 [17.791–17.883] | 4975.0 [4943.4–5001.5] | 0.877 / 1.601 / 2.722 | 1.601–1.637 | 10312.3 [10308.6–10317.0] |
| pg_bigm GIN | 194.328 [194.234–194.344] | 17.105 [17.042–17.471] | 5074.4 [5041.9–5136.5] | 0.850 / 1.578 / 2.576 | 1.544–1.624 | 10325.5 [10325.3–10326.0] |
| PGroonga | 1168.027 [1168.027–1168.027] | 20.631 [20.601–20.771] | 4194.8 [2787.9–4238.4] | 1.061 / 1.932 / 3.019 | 1.919–3.238 | 9814.2 [9806.7–9818.0] |

GIN size is pg_relation_size(search_body). PGroonga returns zero there, so its size is **DB-directory apparent-size growth** (du -sb before/after index creation), including its external files and small catalog changes; it is not an allocated-block measurement. The control includes the same normalization column, production indexes and common Channel/date B-tree. Build time includes the CREATE INDEX client invocation, excluding extension installation and ANALYZE. Relative insert-throughput changes paired to the control in each round are **pg_trgm GIN -9.2% [-10.4–-9.1%]; pg_bigm GIN -7.3% [-8.5–-6.9%]; PGroonga -23.8% [-49.4–-22.6%]**. These short, non-adjacent pairs are not isolated causal estimates. WAL means PostgreSQL LSN bytes; PGroonga internal-file logging/I/O is not totalled by that counter.

Query results below are **p50 / p95 / p99 ms [p95 min–max]** for the app role at five clients. Hit counts are the complete visible/recent result sets, not just the first page. ASCII length coverage is a/ph/pha, with rare zx/QZX; ø is an additional non-ASCII Latin case.

| Query/input | Scalars after normalization | Visible hits | pg_trgm | pg_bigm | PGroonga |
|---|---:|---:|---:|---:|---:|
| 開 | 1 | 153,727 | 0.836 / 1.826 / 21.762 [1.610–1.855] | 0.833 / 1.727 / 21.758 [1.632–1.805] | 0.843 / 1.649 / 21.831 [1.608–1.735] |
| 麒 | 1 | 344 | 1019.947 / 1032.340 / 1038.236 [1027.032–1048.194] | 1019.114 / 1046.712 / 1099.173 [1039.525–1058.099] | 1017.609 / 1043.473 / 1107.961 [1029.295–1045.610] |
| 開発 | 2 | 153,727 | 993.844 / 1048.475 / 1065.774 [1027.884–1070.284] | 991.057 / 1016.233 / 1046.909 [1016.154–1024.235] | 993.372 / 1047.352 / 1101.343 [1033.640–1076.161] |
| 麒麟 | 2 | 344 | 1032.322 / 1060.176 / 1094.535 [1052.507–1196.550] | 1025.140 / 1049.617 / 1082.612 [1037.762–1063.053] | 1028.701 / 1074.117 / 1107.967 [1050.968–1094.096] |
| 確認し | 3 | 226,960 | 1001.717 / 1065.171 / 1088.458 [1019.562–1162.551] | 1008.735 / 1059.356 / 1093.752 [1040.662–1087.319] | 1001.693 / 1020.699 / 1072.578 [1012.325–1039.327] |
| 特殊照合 | 4 | 344 | 1036.073 / 1084.677 / 1119.554 [1048.960–1248.146] | 1033.821 / 1054.309 / 1096.601 [1042.510–1055.756] | 1030.806 / 1057.512 / 1108.910 [1056.926–1107.981] |
| a | 1 | 289,060 | 0.543 / 1.299 / 19.553 [1.061–1.310] | 0.541 / 1.097 / 19.274 [1.088–1.206] | 0.547 / 1.163 / 20.508 [1.134–11.282] |
| ph | 2 | 156,414 | 0.852 / 1.783 / 19.093 [1.705–1.870] | 0.851 / 1.674 / 18.660 [1.650–1.745] | 0.862 / 1.805 / 19.077 [1.798–1.955] |
| pha | 3 | 156,414 | 0.843 / 1.849 / 18.127 [1.765–2.215] | 0.838 / 1.918 / 18.646 [1.839–1.957] | 0.850 / 1.780 / 18.660 [1.779–1.782] |
| ø (non-ASCII Latin) | 1 | 344 | 1018.425 / 1049.928 / 1070.995 [1028.887–1221.468] | 1015.519 / 1032.384 / 1032.632 [1027.541–1044.018] | 1017.635 / 1034.450 / 1046.780 [1030.102–1046.616] |
| zx | 2 | 344 | 1019.123 / 1054.767 / 1103.086 [1034.559–1213.381] | 1019.577 / 1034.482 / 1112.860 [1030.731–1279.564] | 1018.356 / 1029.415 / 1043.703 [1027.532–1029.612] |
| QZX | 3 | 344 | 1021.656 / 1056.596 / 1193.487 [1041.339–1198.004] | 1025.143 / 1056.272 / 1072.606 [1034.196–1160.122] | 1021.718 / 1031.088 / 1075.598 [1030.813–1047.324] |
| がぎ (NFC) | 2 | 3,623 | 1199.871 / 1218.079 / 1245.796 [1214.313–1274.023] | 1205.191 / 1229.809 / 1256.027 [1219.846–1284.051] | 1198.860 / 1219.036 / 1240.418 [1211.035–1230.859] |
| がぎ (NFD input) | 2 | 3,623 | 1205.283 / 1259.938 / 1273.448 [1259.574–1315.447] | 1201.266 / 1232.521 / 1290.476 [1221.043–1236.446] | 1199.428 / 1224.796 / 1248.474 [1221.777–1227.463] |
| CAFÉ | 4 | 3,623 | 1005.202 / 1051.776 / 1058.939 [1027.431–1112.268] | 1007.116 / 1032.551 / 1061.243 [1021.835–1055.340] | 1007.051 / 1064.466 / 1068.350 [1053.029–1065.252] |
| STRASSE | 7 | 3,623 | 1008.421 / 1057.927 / 1063.361 [1027.375–1120.030] | 1017.281 / 1072.647 / 1076.984 [1047.203–1074.693] | 1012.519 / 1029.607 / 1083.323 [1026.093–1056.243] |
| ΣΊΣΥΦΟΣ | 7 | 3,623 | 997.577 / 1027.070 / 1053.553 [1015.326–1045.673] | 996.444 / 1014.650 / 1053.777 [1008.633–1018.598] | 997.324 / 1009.325 / 1052.000 [1006.708–1025.641] |
| 照合z9 | 4 | 344 | 1016.309 / 1034.712 / 1079.134 [1033.434–1039.065] | 1014.856 / 1030.839 / 1066.878 [1030.304–1031.958] | 1014.295 / 1067.471 / 1088.087 [1064.321–1081.255] |
| 開発 API (one space) | 6 | 1,704 | 1013.497 / 1026.905 / 1063.137 [1026.233–1069.768] | 1012.044 / 1062.786 / 1063.036 [1046.976–1076.296] | 1012.321 / 1030.900 / 1070.608 [1021.318–1033.082] |
| 開発  API (two spaces) | 7 | 1,704 | 1013.355 / 1035.155 / 1071.713 [1031.960–1049.002] | 1015.405 / 1031.615 / 1059.686 [1030.207–1070.703] | 1010.473 / 1033.076 / 1068.177 [1020.225–1035.467] |
| x%y | 3 | 1,704 | 380.457 / 390.663 / 402.226 [389.162–411.525] | 381.141 / 391.327 / 400.622 [385.157–399.542] | 380.344 / 390.950 / 400.737 [385.893–403.042] |
| a_b | 3 | 1,704 | 381.910 / 393.911 / 402.836 [388.101–421.338] | 383.067 / 393.068 / 400.953 [386.587–397.698] | 381.142 / 393.843 / 449.837 [388.125–400.127] |
| c\d | 3 | 1,704 | 379.916 / 386.937 / 400.291 [382.361–397.119] | 381.047 / 389.131 / 404.333 [388.308–389.595] | 382.054 / 390.272 / 400.438 [384.692–395.034] |
| 開発 (edge White_Space) | 2 | 153,727 | 988.051 / 1055.119 / 1055.200 [1000.764–1068.759] | 986.367 / 1045.769 / 1057.517 [999.599–1052.236] | 983.746 / 999.484 / 1039.294 [992.647–1010.023] |
| BOM + 開発 + BOM | 4 | 0 | 1008.254 / 1089.909 / 1150.414 [1023.372–1154.335] | 1007.022 / 1024.557 / 1052.393 [1013.084–1024.786] | 1003.263 / 1017.161 / 1053.562 [1016.622–1034.500] |
| ｶﾀｶﾅ | 4 | 3,623 | 1019.673 / 1089.510 / 1156.101 [1040.483–1128.159] | 1007.203 / 1030.188 / 1055.282 [1018.539–1044.108] | 1005.500 / 1041.035 / 1064.281 [1031.631–1055.483] |
| ＡＢＣ | 3 | 3,623 | 1010.200 / 1051.500 / 1071.154 [1036.171–1089.489] | 1006.628 / 1045.944 / 1047.279 [1024.414–1046.210] | 1011.773 / 1028.812 / 1057.850 [1019.268–1033.229] |
| 🦉 | 1 | 344 | 1029.156 / 1053.478 / 1113.140 [1041.005–1103.272] | 1025.344 / 1035.118 / 1052.978 [1033.957–1046.358] | 1025.166 / 1040.020 / 1054.305 [1036.470–1061.367] |

All engines have app-role cases above 500 ms on this Mac. Worst median p95 is **pg_trgm GIN 1259.938 ms [1259.574–1315.447]; pg_bigm GIN 1232.521 ms [1221.043–1236.446]; PGroonga 1224.796 ms [1221.777–1227.463]**, each for NFD がぎ (normalized to the same two-character query as NFC). Many per-query ranges overlap. The app plans do not use the search indexes, so these timings do not demonstrate an app-path full-text-index benefit.

Completeness: **224/224 full result-set comparisons per engine** match, plus 28 ordered first-page comparisons per engine. The reference disables index, index-only and bitmap scans and joins one sequential Message scan to the visible Channels, using strpos(normalized_body, normalized_query)>0. The candidates use escaped LIKE. All six actors are checked: Owner with grants to only some private Channels (30 visible), Member (24), Guest with grants (8), Guest without grants (0), reactivated Member with stale private grants (20 public only), and deactivated Member (0). Cross-Organization context, unset context and Account-only context expose no Messages. Separate owner checks force index access so fallback scans cannot hide tokenizer misses. Full sorted ids are compared for scoped results; direct whole-corpus index checks compare count/ordered-id digest. No missed hits were found, including two-character Japanese and internal ASCII substrings. NFC/NFD inputs normalize identically; internal spaces, width distinctions and literal wildcard characters retain reference semantics.

Representative EXPLAIN evidence is from repetition 1, outside latency samples. For **麒麟**, the app role returns **344** visible/recent hits overall; the first page has 20. All three app plans use the scoped Channel/date B-tree and a body LIKE **Filter**, not the search index. The rare two-character app EXPLAIN execution times are trgm **912.888 ms**, bigm **912.350 ms**, PGroonga **910.865 ms**. Example pg_bigm excerpt (predicate values abbreviated):

```text
Bitmap Heap Scan on messages m (... rows=14.33 loops=24)
  Recheck Cond: organization_id=OrgA AND channel_id=v.id AND created_at in range
  Filter: normalized_body ~~ '%麒麟%'
  Heap Blocks: exact=289670 lossy=33383
  -> Bitmap Index Scan on search_channel_recent
       Index Cond: organization_id=OrgA AND channel_id=v.id AND created_at in range
Execution Time: 912.350 ms
```

There is no full Messages sequential scan in that timed-query plan: the index bounds retain Organization, visible Channel and 180-day range. However, lossy bitmap pages recheck unrelated rows on those pages (8,048 rows removed by index recheck per loop on average). This is **not** evidence of zero work on other Channels' rows/pages. The requested healthy search-index plan under RLS was **not demonstrated**. Owner-only diagnostics can use search_body, while the app-role body predicate remains after RLS; PostgreSQL's security ordering restricts promotion of non-leakproof predicates ([RLS evaluation rules](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)). This is the main unresolved query/RLS constraint, not a reason to bypass RLS.

The following diagnostic removes visibility/range filtering and runs as the **owner**, forcing index access on the same million normalized bodies. It is one EXPLAIN execution per engine, **not five-client app latency**:

| Direct owner lookup for 麒麟 | pg_trgm GIN | pg_bigm GIN | PGroonga |
|---|---:|---:|---:|
| Execution Time (ms) | 1464.646 | 2.479 | 3.995 |
| Matching Messages | 1,003 | 1,003 | 1,003 |
| Heap rows rechecked/retrieved | 1,000,000 | 1,003 | 1,003 |

pg_trgm cannot extract a trigram from this two-character substring pattern: its forced GIN lookup degenerates into a full-index search, followed by rechecking **998,997** non-matches and returning all **1,003** correct hits. Lossy bitmap representation reports 390,494 rows at the bitmap index node; that is not the number of heap rows examined. The app planner instead uses scoped B-tree filtering. Thus two-character queries are **complete**, not silently empty, but lack selective trigram access. pg_bigm and the configured PGroonga have selective two-character access in the owner diagnostic; this potential is unavailable in the measured app/RLS query.

Dump/restore: each variant gets a 1,000-Message database using the same migrations, fixture and engine index. The owner runs pg_dump -Fc, restores into a new database with pg_restore --exit-on-error --no-owner --no-acl, then reapplies deploy/db-grants.sql. Row count and ordered id/body digest are identical before/after (`1000 | 68271355798ed2122a55d62ef4738d65`); all restored visibility/RLS controls and 28 page comparisons also match. Extension SQL versions are pg_trgm **1.6**, pg_bigm **1.2**, PGroonga **4.1.0**.

| Restored index | Restore wall time (ms) | Full result-set comparisons | Data digest |
|---|---:|---:|---|
| pg_trgm | 175.372 | 224/224 equal | equal |
| pg_bigm | 165.009 | 224/224 equal | equal |
| PGroonga | 196.395 | 224/224 equal | equal |

Operating cost: pg_trgm ships with the pinned PostgreSQL image. pg_bigm adds a checksum-pinned source build and matching PostgreSQL headers; it uses PostgreSQL's GIN/WAL/backup machinery. PGroonga adds the official Groonga package repository, libgroonga and its package compatibility, external index files, WAL/recovery settings and background workers. Both extra engines require a custom database image and matching extension binaries before restore; these small SQL dump/restore drills succeeded on the common image, not on the unmodified official image. The measurement image retains build tools and is not a proposed optimized production image.

For PostgreSQL major upgrades, install extension binaries for the target major and validate a restore/upgrade before rollout; a major-version upgrade was not executed here ([PostgreSQL upgrade requirements](https://www.postgresql.org/docs/18/pgupgrade.html)). For pg_bigm, rebuild against the target PostgreSQL and apply extension SQL updates when its extension version changes. PGroonga's compatible upgrades update the binary/extension; incompatible changes require recreating its indexes ([PGroonga upgrade path](https://pgroonga.github.io/upgrade/)). Its primary crash-safer is still documented as experimental; WAL resource-manager and primary recovery are separate configuration responsibilities ([WAL resource manager](https://pgroonga.github.io/reference/modules/pgroonga-wal-resource-manager.html), [primary crash-safer](https://pgroonga.github.io/reference/modules/pgroonga-crash-safer.html)). These costs are operational, not a measured hosting-price estimate. Standby/PITR and actual crash recovery were not tested. Any Unicode/case-folding change also requires refreshing stored normalized values and rebuilding indexes, followed by completeness checks, for every engine.

Limits: one shared Mac/VM, one synthetic seed with a small phrase vocabulary, retained guest filesystem caches, no production Linux hardware or full API path. Prepared statements contain a constant pattern per class; generic-plan reuse across different terms, mixed query traffic, concurrent search/send load and sustained write maintenance were not measured. The fixed repeated-text insert payload and 1,000-insert windows do not establish amortized GIN pending-list cleanup, Groonga compaction or total physical write amplification. The first write repetition follows plans/completeness diagnostics; later ones follow query timing, with the same 50-insert warm-up and checkpoint, so cache/history differences may contribute to the write variance. Historical IDs/time placement and message-length/vocabulary distributions are synthetic. DMs could not be included because the measured schema has no DM implementation. No healthy full-text-index plan under the required app/RLS path was obtained; the scoped B-tree plans still have lossy page rechecks. Containers/volumes were removed after completion; the measurement image and external artifacts remain. Load TypeScript checks (including the new directory), all 35 existing load unit tests and git diff --check succeeded.

Provisional recommendation: **pg_bigm GIN, with two-character queries enabled, for the next RLS-safe/Linux prototype**. Its selective two-character lookup, smaller measured index, PostgreSQL GIN backup/WAL model and higher measured insert throughput than PGroonga justify investigating that new dependency; pg_trgm remains complete for two-character queries but cannot selectively prune this substring pattern. This recommends the next candidate to test; it does not clear the implementation gate or approve a production dependency. Before implementation, investigate an RLS-compatible indexed query shape, reduce repeated per-Channel/lossy heap work, and measure work_mem/shared_buffers/JIT alternatives under the same visibility/denial checks. Then repeat on Linux with **1,000,000 Messages, 5 concurrent searches, the same 180-day semantics and p95 <= 500 ms**. The current Mac app-role path exceeds 500 ms across many classes. **Production Linux performance is unverified and no formal performance pass is declared.** No decisions entry was added.

## #314 step 3b subscription context round trips (2026-11-13)

Rust 1.99.0, SQLx 0.8.6, debug profile, isolated test PostgreSQL at loopback port 55471. `realtime::tests::round_trips::measure_subscription_round_trips` counts PostgreSQL frontend Query/Sync/Flush boundaries through a local plaintext test relay; packet counts are not used. An authenticated socket subscribes to one empty Channel four times on a pool capped at three, with checkout health probes disabled. The last two subscriptions have no Parse messages; authentication and fixture work are outside the window. Independent source snapshots/build directories compare local `origin/main` 1069a9f, PR head df7319c, and this fix; no Git state is changed.

| Per warm subscription | main 1069a9f | PR df7319c | Fixed |
|---|---:|---:|---:|
| Data/control statement executions | 13 | 30 | 13 |
| Wire round trips, including SQLx pool Sync overhead | 20 | 37 | 20 |

A subscription has five visibility/access reads and two watermarks: single-statement reads cost 1 -> 4 -> 1 executions; each barrier-protected watermark costs 4 -> 5 -> 4. The barrier wait and subsequent fresh READ COMMITTED sequence snapshot remain separate. First-subscription wire counts were 30/51/34 respectively, including prepare and connection/cache initialization; they do not represent the steady-state cost.

Reproduce on the isolated test database with `cargo test --locked -p fukulow-server --lib measure_subscription_round_trips -- --ignored --nocapture` after setting DATABASE_URL explicitly. This is a protocol-cost comparison, not a latency or production-capacity guarantee. Single-batch access checks now use one statement; larger per-Organization checks retain their REPEATABLE READ transaction.

The unchanged 512-socket/20-connection/1 s admission-deadline regression passed 10/10 isolated repetitions and again in the full Rust suite. An earlier exploratory run failed with a global watermark admission rejection during concurrent baseline compilation; the isolated loop ran after all builds finished. SQLx reported test-database cleanup warnings during the loop, without test failures.

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

### #318 explicit edge-table cost (2026-11-14)

Before: `c30f79d8177fc0645159a11b98fc5d5abf97f3a5` (`origin/main`, the clean starting checkout; local `main` was older, but its checker files were identical). After: the same checkout with #318 checker changes. Rust 1.99.0 (b940084d7), Node 26.13.0, macOS 27.0.1 ARM64, Apple M5, 32 GiB RAM. Same method as #80: prebuilt web assets, cached dependencies, an untimed warm-up per version, then the exact `node scripts/check-module-direction.ts` step timed with `/usr/bin/time -p`, with `cargo clean -p fukulow-server` before each of three runs. The fixture command is `node --test scripts/check-module-direction.test.ts`, timed once per version, including driver builds.

| Version | Check runs (s) | Check median (s) | Fixture suite (s) | Tests passed |
| --- | --- | --- | --- | --- |
| Before | 10.22, 9.58, 9.12 | 9.58 | 8.25 | 71 |
| After | 9.05, 8.96, 9.15 | 9.05 | 12.06 | 84 |

No observed production-check regression; the fixture suite now builds both production and fixture-only drivers and covers table validation, injection isolation, siblings and direct-edge enforcement. Limits: other AI workers may be running on this host; runs were sequential before/after, with no CPU isolation, and the difference is within run variability. #80's historical 1.74 s / 1.68 s medians used the same method, but a different source snapshot and host conditions, so absolute times are not directly comparable. No new rustc API or dependency was added.

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

### Transaction-local Organization setting cost (#314, 2026-11-13)

- Purpose: the cost of running each hot query inside a transaction that first sets `fukulow.organization_id` locally (the #314 helper), still without RLS. Same machine, PostgreSQL 18.6 and `hot-plans` dataset as above; source main 1069a9f.
- Plans reproduce: `psql -X [-v generic=1] -v org_context=1 -f load/hot-plans/plans.sql` as `fukulow_app`, six passes per mode, medians of passes 2–6, compared with passes without `org_context` taken in the same session. Execution Time of every measured statement stays within run-to-run noise (custom → custom+context: VIS 0.017 → 0.022, history latest 0.034 → 0.032, replay 0.050 → 0.056, timeline latest 33.900 → 34.086, fan-out `member_access` 0.952 → 0.961, Unread counts 19.478 → 19.660 ms; generic plans likewise). The `set_config` statement itself: median 0.002–0.003 ms, max 0.007 ms.
- Latency reproduce: `LATENCY_SECONDS=30 node load/hot-latency.ts`, with `HOTPLANS_CONTAINER` naming the throwaway container and the app role's test-only password in the libpq password variable (pgbench inside the container, prepared statements, per-transaction logs), three runs; medians of the three.

| Script | Clients | Context | Transactions/s | p50 / p95 / p99 ms (p95 range) |
|---|---:|---|---:|---|
| History latest page | 1 | none | 11,560 | 0.086 / 0.092 / 0.100 (0.088–0.094) |
| History latest page | 1 | BEGIN, set, query, COMMIT | 5,934 | 0.167 / 0.180 / 0.189 (0.177–0.180) |
| History latest page | 8 | none | 73,987 | 0.075 / 0.192 / 0.233 (0.184–0.195) |
| History latest page | 8 | BEGIN, set, query, COMMIT | 52,262 | 0.096 / 0.309 / 0.380 (0.305–0.320) |
| Replay 50 after cursor | 1 | none | 13,704 | 0.070 / 0.080 / 0.086 (0.080–0.081) |
| Replay 50 after cursor | 1 | BEGIN, set, query, COMMIT | 6,394 | 0.155 / 0.167 / 0.180 (0.165–0.169) |
| Replay 50 after cursor | 8 | none | 80,462 | 0.070 / 0.173 / 0.216 (0.166–0.174) |
| Replay 50 after cursor | 8 | BEGIN, set, query, COMMIT | 55,191 | 0.091 / 0.295 / 0.374 (0.281–0.295) |

- The measured SQL itself is unchanged (pgbench per-statement averages: history 0.087 vs 0.088 ms, replay 0.072 vs 0.076 ms with one client); the added cost is the three extra round trips (BEGIN, `set_config`, COMMIT ≈ 0.08 ms per transaction on loopback). This is why #314 step 3b sets the context inside the same statement for single-statement hot reads.
- Limits: loopback inside the container (no network latency; a real network multiplies the round-trip cost), one dataset, warm cache, no RLS yet, pgbench rather than the server. Not a guarantee. Raw outputs stay outside Git.

### Distinct-session fallback pass under RLS (#314 step 4, 2026-11-13 JST)

Reproduce from `server/`: `cargo test --release --lib measure_distinct_session_pass_within_five_seconds -- --ignored --nocapture` against a disposable PostgreSQL 18 database (local Docker, loopback). The pass runs as the RLS-restricted test app role, one Organization transaction per Organization. Layouts are provisioned one after the other with disjoint ids (Member rows cannot be truncated), so the 1,000-Organization run also holds the 10-Organization run's 100,000 rows.

| Sessions (chunks) | 10 Organizations (ms) | 1,000 Organizations (ms) |
| ---: | ---: | ---: |
| 1,000 (1) | 23 | 792 |
| 10,000 (10) | 38 | 823 |
| 100,000 (100) | 380 | 1,146 |

Result: every pass met the 5,000 ms deadline under RLS. With 1,000 Organizations the per-Organization transactions add about 0.8 s, independent of the session count. Compare with the #157 one-Organization pass above (16/90/253 ms, without RLS).

Limits: one run per layout on a shared development host, local PostgreSQL, no WebSockets or concurrent publishing; the second layout is measured on a larger table.

## RLS before/after (#314 step 5, 2026-11-13 JST)

Purpose: isolate RLS enablement: B = a999a35^ (6dcadb7, context plumbing without policies), A = a999a35 (#343, RLS enabled). Fresh reruns replace the historical step 2 numbers as the comparison denominator; later context plumbing is present on both sides. Ran B/A/B/A/B/A in this session, 11:30–11:49 JST, with one fresh isolated PostgreSQL database per side/run for plans + latency and another fresh database for each end-to-end run. The detached B worktree was unchanged.

Conditions: Apple M5 / 10 CPUs / 32 GiB, macOS 27.0.1 arm64; Docker 29.9.3, VM 10 CPUs / 7.748 GiB; pinned PostgreSQL 18.6 image e3d24f69…, shared_buffers 128MB, work_mem 4MB, default JIT; k6 1.8.2 (00fdceba…); Rust 1.99.0 release images built separately from each source before timing, container Node 26.13.0, host orchestration Node 26.8.1. No competing cargo suite/build or load run was found before starting or during spot checks, so no wait was needed. Six pre-existing development PostgreSQL containers remained running, near idle; interactive desktop activity continued. No TLS/proxy, Docker bridge transport to the loopback-published app, no load warm-up. All app/pgbench/EXPLAIN connections used non-owner fukulow_app (NOBYPASSRLS).

Reproduce (test-only database/password variables supplied via environment; never record their values):

- Create B with `git worktree add --detach /private/tmp/fukulow-314-step5-before 6dcadb7`; use this worktree at a999a35 for A. Build a separate release Docker image from each source; run the same A measurement harness with `LOAD_SERVER_SOURCE` and `LOAD_APP_IMAGE` selecting that side. Before/after SQL harness files are identical. Exact runner and raw outputs: `/private/tmp/fukulow-314-step5/run.ts`, `before/run{1,2,3}/`, `after/run{1,2,3}/`; analysis and index-condition audit also stay there, outside Git.
- Plans: pinned fresh PostgreSQL 18.6, `sqlx migrate run --source "$SIDE_TREE/server/migrations"`, that side's `deploy/db-roles.sql` and `deploy/db-grants.sql`, then the unchanged `load/hot-plans/seed.sql` as owner. Same step 2 dataset: Org A 10,000 Members, 50 Channels, hot Channel 100,000 Messages (70,000 in 2,000 Topics), other Channels 2,000 each; Org B 1,000 Members and 10 × 5,000 Messages; 406,800 Channel positions and 2,000 measured-Member Topic positions, last-100 cut-off. As app role: `psql -X -v org_context=1 [-v generic=1] -f load/hot-plans/plans.sql`, six fresh-session passes per mode per run. Default's first executions are Custom; its repeated `auto.*` sections test Auto. All writes roll back. Tables use medians of passes 2–6, then the median of the three run medians; buffers are execution-root shared hits + reads, excluding planning, reported Custom; Generic. † marks >10% **and** >0.05 ms Execution Time growth in at least one mode.
- Latency: `HOTPLANS_CONTAINER="$DB" LATENCY_CTX=1 LATENCY_SECONDS=30 LATENCY_RESULT_DIR="$OUT/latency-reports" node load/hot-latency.ts`, prepared pgbench, 1 and 8 clients, three runs per side. Same historical harness: “History latest page” actually pages 51 Messages before a uniformly random cursor; Replay returns 50 after a random cursor. Each transaction uses BEGIN/local context/query/COMMIT. Each percentile and transactions/s is independently medianed across three runs; ranges are per-run p95.
- Load: `CHANNELS=1 SUBSCRIBERS=20 PUBLISHERS=2 PUBLISH_INTERVAL_MS=100 DURATION_SECONDS=30 READY_TIMEOUT_SECONDS=15 DRAIN_TIMEOUT_SECONDS=10 LOAD_RESULT_DIR="$OUT/load" LOAD_SERVER_SOURCE="$SIDE_TREE" LOAD_APP_IMAGE="$SIDE_IMAGE" make load-record`. Three runs per side, identical step 2 offered load, fresh DB and app each time.

| Query (Execution Time, ms) | Custom B → A (change) | Generic B → A (change) | Shared buffers C; G (B → A) |
|---|---:|---:|---:|
| `auth` | 0.029 → 0.037 (+27.6%) | 0.028 → 0.040 (+42.9%) | 6 → 6; 6 → 6 |
| `vis` | 0.018 → 0.023 (+27.8%) | 0.019 → 0.022 (+15.8%) | 5 → 5; 5 → 5 |
| `watermark.shared_lock` | 0.011 → 0.011 (+0.0%) | 0.012 → 0.013 (+8.3%) | 0 → 0; 0 → 0 |
| `watermark` | 0.007 → 0.011 (+57.1%) | 0.007 → 0.010 (+42.9%) | 1 → 1; 1 → 1 |
| `send.member_lock` | 0.018 → 0.021 (+16.7%) | 0.017 → 0.022 (+29.4%) | 4 → 4; 4 → 4 |
| `send.channel_public` | 0.005 → 0.006 (+20.0%) | 0.005 → 0.007 (+40.0%) | 1 → 1; 1 → 1 |
| `send.existing` | 0.020 → 0.013 (-35.0%) | 0.011 → 0.012 (+9.1%) | 3 → 3; 3 → 3 |
| `send.reply_parent` | 0.036 → 0.039 (+8.3%) | 0.038 → 0.042 (+10.5%) | 4 → 4; 4 → 4 |
| `send.channel_lock` | 0.005 → 0.005 (+0.0%) | 0.008 → 0.006 (-25.0%) | 0 → 0; 0 → 0 |
| `send.next_seq` | 0.045 → 0.046 (+2.2%) | 0.047 → 0.047 (+0.0%) | 11 → 11; 11 → 11 |
| `send.topic_join` | 0.042 → 0.038 (-9.5%) | 0.041 → 0.040 (-2.4%) | 17 → 17; 17 → 17 |
| `send.topic_id` | 0.007 → 0.007 (+0.0%) | 0.009 → 0.008 (-11.1%) | 5 → 5; 5 → 5 |
| `send.insert_message` | 0.201 → 0.181 (-10.0%) | 0.190 → 0.190 (+0.0%) | 30 → 30; 30 → 30 |
| `send.topic_record` | 0.031 → 0.034 (+9.7%) | 0.031 → 0.039 (+25.8%) | 12 → 12; 12 → 12 |
| `history.latest` | 0.035 → 0.039 (+11.4%) | 0.036 → 0.042 (+16.7%) | 8 → 8; 8 → 8 |
| `history.before_old` | 0.033 → 0.039 (+18.2%) | 0.035 → 0.041 (+17.1%) | 6 → 6; 6 → 6 |
| `timeline.latest` † | 36.760 → 41.628 (+13.2%) | 145.103 → 184.700 (+27.3%) | 5566 → 5566; 644704 → 644704 |
| `timeline.topic` | 0.135 → 0.161 (+19.3%) | 7.104 → 7.404 (+4.2%) | 336 → 336; 12478 → 12478 |
| `replay` | 0.052 → 0.056 (+7.7%) | 0.061 → 0.066 (+8.2%) | 10 → 10; 10 → 10 |
| `fanout.member_access_1024` † | 0.992 → 1.422 (+43.3%) | 1.105 → 1.560 (+41.2%) | 2181 → 2181; 3119 → 3119 |
| `fanout.access_rows_1024` † | 2.522 → 5.102 (+102.3%) | 2.679 → 2.746 (+2.5%) | 226 → 226; 9862 → 5819 |
| `unread.visible_list` † | 0.636 → 1.512 (+137.7%) | 0.700 → 1.535 (+119.3%) | 74 → 74; 74 → 74 |
| `unread.list_counts` | 20.512 → 22.418 (+9.3%) | 4.053 → 4.254 (+5.0%) | 3814 → 3864; 3814 → 3864 |
| `read.position_lock` | 0.012 → 0.015 (+25.0%) | 0.011 → 0.013 (+18.2%) | 7 → 7; 7 → 7 |
| `read.mark_channel` | 0.039 → 0.042 (+7.7%) | 0.036 → 0.038 (+5.6%) | 15 → 15; 15 → 15 |
| `read.topic_exists` | 0.011 → 0.013 (+18.2%) | 0.012 → 0.014 (+16.7%) | 3 → 3; 3 → 3 |
| `read.mark_topic` | 0.027 → 0.029 (+7.4%) | 0.026 → 0.029 (+11.5%) | 12 → 12; 12 → 12 |

| Auto (default cache mode) | Execution Time B → A, ms | Shared buffers B → A |
|---|---:|---:|
| `auto.timeline` † | 142.723 → 184.177 (+29.0%) | 644699 → 644699 |
| `auto.list_counts` | 3.828 → 4.034 (+5.4%) | 3814 → 3864 |

| Latency script / clients | B p50 / p95 / p99 ms | A p50 / p95 / p99 ms | p95 change (B; A ranges) | Transactions/s B → A |
|---|---:|---:|---:|---:|
| history-1 | 0.155 / 0.174 / 0.185 | 0.163 / 0.178 / 0.189 | +2.3% (0.172–0.179; 0.174–0.184) | 6326.8 → 6074.4 (-4.0%) |
| history-8 | 0.154 / 0.312 / 0.381 | 0.192 / 0.351 / 0.431 | +12.5% (0.306–0.358; 0.314–0.471) | 45324.1 → 38465.6 (-15.1%) |
| replay-1 | 0.151 / 0.165 / 0.174 | 0.151 / 0.166 / 0.177 | +0.6% (0.163–0.168; 0.161–0.170) | 6568.7 → 6537.8 (-0.5%) |
| replay-8 | 0.177 / 0.350 / 0.436 | 0.183 / 0.338 / 0.408 | -3.4% (0.291–0.383; 0.306–0.437) | 40492.2 → 40406.8 (-0.2%) |

| Load side/run | Accepted sends / s | Deliveries / missing / errors | Delivery median / p95 / p99 ms | Send HTTP median / p95 / p99 ms | Queries/send | Peak CPU app / DB / generator % |
|---|---:|---|---|---|---:|---|
| B1 | 600 / 19.9993 | 12,000 / 0 / 0 | 8 / 12 / 15 | 7 / 10 / 13 | 11.010 | 5.97 / 8.85 / 8.98 |
| A1 | 600 / 20.0000 | 12,000 / 0 / 0 | 8 / 14 / 16 | 7 / 12 / 14 | 11.010 | 5.83 / 13.12 / 8.82 |
| B2 | 600 / 20.0000 | 12,000 / 0 / 0 | 8 / 11 / 13 | 6 / 10 / 11 | 11.010 | 5.99 / 9.63 / 7.74 |
| A2 | 600 / 19.9993 | 12,000 / 0 / 0 | 8 / 12 / 14 | 7 / 10 / 12 | 11.010 | 6.03 / 13.19 / 8.49 |
| B3 | 600 / 19.9993 | 12,000 / 0 / 0 | 8 / 11 / 13 | 7 / 9 / 11 | 11.010 | 5.68 / 11.02 / 7.34 |
| A3 | 600 / 19.9993 | 12,000 / 0 / 0 | 8 / 12 / 14 | 7 / 10 / 12 | 11.010 | 6.01 / 11.64 / 7.95 |

Load medians: accepted rate 19.9993 → 19.9993/s (0.0%); send HTTP median/p95/p99 7/10/11 → 7/10/12 ms (p95 0.0%); delivery 8/11/13 → 8/12/14 ms (p95 +9.1%). Every run accepted 600/600 sends, delivered 12,000/12,000, passed all 1,244 checks, and peaked at 20 sockets / 2 publishes. Harness-reported top-level queries/send stayed 11.010 (transaction control excluded). CPU peaks above sample the whole generator run, including provisioning/boundaries/drain; 100% is one core.

Plan findings and analysis:

- Index names, scan methods and conflict-arbiter indexes are retained on every query. Node shapes are **not** identical. Added Result/One-Time Filter gates change `vis`, `watermark`, `send.member_lock`, `send.channel_public`, `send.existing`, `send.reply_parent`, `send.topic_id`, `send.topic_record`, `history.latest`, `history.before_old`, `timeline.latest`, `timeline.topic`, `replay`, `fanout.member_access_1024`, `unread.visible_list`, `unread.list_counts`, `read.position_lock`, `read.mark_channel`, `read.topic_exists`, `auto.timeline` and `auto.list_counts`. AUTH additionally gains the Account-policy users_account_id subplan (not executed with the Organization policy already true); timeline reorders access/w CTE joins and, for custom single Topic, the position joins. `fanout.access_rows_1024` retains node topology but gains policy filters. The two advisory locks, sequence upsert, Topic join, Message INSERT and Topic-position upsert retain node topology (write policy checks do not appear as separate nodes). Shape/index-name findings were stable across all retained passes.
- Policy expressions inline fukulow_current_org() as `NULLIF(current_setting('fukulow.organization_id', true), '')::uuid`. Single-Organization scans mostly get startup gates; users additionally has the Account-read OR predicate, evaluated per row. Generic/Auto timeline retains Incremental Sort + GroupAggregate over 70,000 Topic Messages, with 70,000 read-position and Topic-position probes each. Added Result gates evaluate context on those repeated probes: generic 145.103 → 184.700 ms (+27.3%), Auto 142.723 → 184.177 (+29.0%); buffer counts stay about 644,700. Custom timeline remains HashAggregate/bulk scans at 36.760 → 41.628 ms (+13.2%). This compounds the existing #326 generic-plan cost.
- Custom `access_rows` still scans 11,000 users and 5,000 grants: per-row context/Account OR filters raise 2.522 → 5.102 ms (+102.3%). `member_access` retains its bounded users index access but filters 1,024 Members and adds Channel gates per candidate: +43.3% Custom / +41.2% Generic. Unread visible list still hashes/scans 5,000 grants; their policy filter accounts for most of its increase (0.636 → 1.512 ms, +137.7%; Generic +119.3%). These and timeline.latest/auto.timeline are every † query; no other median meets both thresholds.
- Index bounds do change in two places. Generic `access_rows` adds Organization to channel_members_by_member's condition, reducing buffers 9,862 → 5,819. Conversely Unread Topic counts in Custom/Generic/Auto lose `seq > COALESCE(tr.read_seq, p.initial_seq)` from messages_topic_seq's Index Cond: it becomes a Filter (about 29 discarded rows per probe), raising that subscan's hits 46 → 96 and total hits 3,814 → 3,864. Index-name retention therefore does not establish identical index use. Custom counts also JIT-compiles 72 vs 69 functions; the measured total rises 9.3% (Generic 5.0%, Auto 5.4%). Other index conditions are unchanged except the added AUTH policy subplan and randomized idempotency keys.
- History's unchanged sequence index/buffers (8) gains a startup policy gate: Custom 0.035 → 0.039 ms, Generic 0.036 → 0.042. This supports incremental SQL overhead, but cannot attribute the full eight-client p95 increase (0.312 → 0.351 ms) to one node: transaction/context round trips and shared VM scheduling also contribute. Replay uses the same indexed page and authorization gates; its median p95 changes +0.6% / −3.4% at 1 / 8 clients.

Verdict: **report to the maintainer before merge**, because eight-client history p95 rises **12.5%**, exceeding #314's 10% criterion. One-client history is +2.3%; Replay stays below the criterion; offered-rate-bound accepted send throughput and send HTTP p95 are unchanged. First load pair alone had HTTP p95 10 → 12 ms (+20%), but the three-run medians are 10 → 10. The flagged hot-query costs and changed Unread index bound remain review points independently of the end-to-end send result.

Candidate mitigations, not implemented: test scalar-subquery/InitPlan context predicates to evaluate settings once, and a policy form that avoids repeated Account/Organization OR evaluation; reduce repeated timeline position probes or select a custom timeline plan (#326), rather than globally forcing custom (Unread custom pays JIT). Explore explicit Organization/candidate bounds for batch scans. For Unread, investigate RLS security ordering and predicate leakproofness before changing the correlated bound/query shape; the existing index already has the seq key. The context functions are already STABLE; that does not make each nested-loop invocation free. Do not mark a function LEAKPROOF without proving its error/data behavior. Any hoisting or policy change must preserve fail-closed semantics and revalidate one-statement context-before-read ordering, reuse and cancellation under both plan modes; no production mitigation was made here.

Limits: one shared desktop/VM and dataset, short warm-plan samples with EXPLAIN overhead, small end-to-end offered load, millisecond generator timing and sampled CPU peaks; no capacity claim. Eight-client p95 ranges overlap substantially, and performance drifts across runs (history B 0.306–0.358, A 0.314–0.471 ms; replay B 0.291–0.383, A 0.306–0.437); the history threshold breach is reported, not claimed to be a fully isolated causal estimate. pgbench measures explicit context transactions, not the server's single-statement adapter. The maintainer decision is recorded below ("Maintainer decision"); the extra pairs below ran on the same shared host, so a steadier isolated rerun is tracked in #357. Harness-only changes expose pgbench's actual transactions/s and optionally preserve its raw report; workload SQL, durations and plans are unchanged on both sides. `node --test load/*.test.ts` passed all 34 tests. All created containers/images and the detached worktree were removed; raw reports remain outside Git.

### Mitigation candidates (#314 step 5)

Follow-up on HEAD 56e0d21 (same machine, Docker allocation, pinned PostgreSQL 18.6 and seed as above). B/A schemas were extracted with `git show` from 6dcadb7/a999a35 into external scratch directories; no production file was changed. Confirmation ran five further interleaved B/A pairs, fresh container/database per side/run, unchanged prepared pgbench SQL, `LATENCY_CTX=1 LATENCY_CLIENTS=8 LATENCY_SECONDS=30`. One A setup failed before timing and was retried after a TCP-readiness check; the failed setup is excluded. Retained all completed timing runs. The original three plus five new runs give the following independently medianed percentiles; for eight values, median is the mean of the central two.

| Script | B median p50/p95/p99 ms | B min–max p50; p95; p99 ms | A median p50/p95/p99 ms | A min–max p50; p95; p99 ms | p95 change |
|---|---|---|---|---|---:|
| history-8 | 0.1735/0.3350/0.4090 | 0.090–0.293; 0.292–0.688; 0.347–1.166 | 0.2095/0.3890/0.4850 | 0.094–0.289; 0.301–0.743; 0.348–1.267 | 16.1% |
| replay-8 | 0.1925/0.3665/0.4510 | 0.084–0.262; 0.269–0.616; 0.324–0.948 | 0.2025/0.3895/0.4835 | 0.098–0.267; 0.283–0.668; 0.346–1.128 | 6.3% |

History-8 still exceeds +10% on the requested pooled medians (**+16.1%**); Replay-8 is +6.3%. This does not establish a repeatable causal +16.1% RLS cost: the new-five medians alone are History 0.520→0.409 ms (−21.3%) and Replay 0.553→0.438 ms (−20.8%); median within-pair changes are +3.1%/+5.2%. All five new p95 pairs (ms), in order: History 0.292→0.301, 0.298→0.409, 0.520→0.743, 0.688→0.670, 0.626→0.369; Replay 0.269→0.283, 0.299→0.438, 0.553→0.668, 0.616→0.615, 0.584→0.342. Large shared-host drift, overlapping ranges and the last-pair setup retry limit attribution. Spot checks found no competing suite/build; the six pre-existing PostgreSQL containers stayed near idle; no thermal warning was recorded.

Forms: **a** hoists every Organization policy predicate, both USING and WITH CHECK, and Account predicates (including the Organizations EXISTS) into scalar-subquery InitPlans. **b** adds `(SELECT fukulow_current_account()) IS NOT NULL AND ...` to both Account-read policies. **c** instead puts both Account-read expressions inside `CASE WHEN (SELECT fukulow_current_account()) IS NULL THEN false ELSE ... END`. These are policy-only changes, applied as owner after seeding; context functions, queries, indexes, grants and data are unchanged.

Plans below are Execution Time ms, Custom/Generic; the last two rows are Auto. Each side/form uses six fresh-session `plans.sql` passes per mode with `org_context=1`, medians of passes 2–6; B/A were remeasured in confirmation run 4, not reused from the earlier three-run table. Candidate plans use run 1; latency uses three fresh databases per form, a/b interleaved, then c.

| Query | B C/G | A C/G | a C/G | b C/G | c C/G |
|---|---:|---:|---:|---:|---:|
| `auth` | 0.029/0.026 | 0.041/0.042 | 0.057/0.053 | 0.061/0.061 | 0.071/0.079 |
| `vis` | 0.021/0.022 | 0.021/0.021 | 0.020/0.021 | 0.020/0.020 | 0.022/0.024 |
| `watermark.shared_lock` | 0.011/0.012 | 0.011/0.013 | 0.011/0.013 | 0.012/0.013 | 0.013/0.014 |
| `watermark` | 0.007/0.008 | 0.009/0.009 | 0.010/0.010 | 0.011/0.011 | 0.012/0.012 |
| `send.member_lock` | 0.018/0.017 | 0.021/0.023 | 0.022/0.023 | 0.022/0.022 | 0.024/0.026 |
| `send.channel_public` | 0.005/0.005 | 0.007/0.006 | 0.006/0.007 | 0.007/0.007 | 0.008/0.008 |
| `send.existing` | 0.010/0.010 | 0.011/0.011 | 0.010/0.012 | 0.011/0.011 | 0.014/0.017 |
| `send.reply_parent` | 0.036/0.036 | 0.038/0.039 | 0.038/0.040 | 0.037/0.038 | 0.048/0.043 |
| `send.channel_lock` | 0.005/0.008 | 0.005/0.005 | 0.004/0.006 | 0.005/0.005 | 0.005/0.007 |
| `send.next_seq` | 0.043/0.047 | 0.048/0.048 | 0.045/0.057 | 0.044/0.053 | 0.054/0.065 |
| `send.topic_join` | 0.038/0.037 | 0.036/0.036 | 0.037/0.040 | 0.038/0.039 | 0.044/0.041 |
| `send.topic_id` | 0.007/0.008 | 0.006/0.009 | 0.006/0.008 | 0.006/0.009 | 0.008/0.009 |
| `send.insert_message` | 0.173/0.182 | 0.181/0.192 | 0.182/0.194 | 0.176/0.189 | 0.203/0.207 |
| `send.topic_record` | 0.026/0.029 | 0.036/0.035 | 0.031/0.033 | 0.031/0.036 | 0.039/0.041 |
| `history.latest` | 0.031/0.034 | 0.034/0.036 | 0.036/0.040 | 0.037/0.039 | 0.046/0.050 |
| `history.before_old` | 0.033/0.035 | 0.038/0.040 | 0.038/0.045 | 0.042/0.042 | 0.051/0.047 |
| `timeline.latest` | 36.179/144.268 | 41.744/184.199 | 41.070/157.209 | 41.513/158.278 | 50.695/191.599 |
| `timeline.topic` | 0.127/7.070 | 0.164/7.295 | 0.145/7.045 | 0.151/7.376 | 0.186/8.260 |
| `replay` | 0.050/0.061 | 0.054/0.066 | 0.056/0.076 | 0.054/0.070 | 0.069/0.079 |
| `fanout.member_access_1024` | 0.959/1.113 | 1.384/1.531 | 1.059/25.950 | 1.107/27.330 | 1.298/1.394 |
| `fanout.access_rows_1024` | 2.499/2.628 | 4.929/2.625 | 2.526/2.243 | 2.542/2.310 | 3.007/2.789 |
| `unread.visible_list` | 0.620/0.700 | 1.472/1.482 | 0.699/0.707 | 0.691/0.743 | 0.871/0.900 |
| `unread.list_counts` | 20.380/4.012 | 22.087/4.187 | 21.723/4.136 | 22.163/4.155 | 26.335/5.099 |
| `read.position_lock` | 0.012/0.012 | 0.015/0.012 | 0.016/0.013 | 0.016/0.013 | 0.018/0.016 |
| `read.mark_channel` | 0.039/0.035 | 0.042/0.036 | 0.044/0.038 | 0.041/0.038 | 0.050/0.043 |
| `read.topic_exists` | 0.011/0.011 | 0.012/0.013 | 0.012/0.014 | 0.012/0.015 | 0.015/0.015 |
| `read.mark_topic` | 0.029/0.026 | 0.029/0.026 | 0.032/0.028 | 0.032/0.029 | 0.037/0.033 |
| `auto.timeline` | 141.143 | 180.588 | 154.145 | 155.276 | 192.513 |
| `auto.list_counts` | 3.799 | 4.013 | 4.008 | 3.973 | 4.982 |

Latency p95 medians [run min–max], ms; B/A use all eight runs for 8 clients, original three for 1 client; every candidate uses three runs per cell. One-client controls were not rerun in this follow-up. Cells are descriptive comparisons, not isolated improvement estimates. Full p50/p95/p99 and transactions/s medians, ranges and individual runs are in external `summary.json`.

| Script/clients | B | A | a | b | c |
|---|---:|---:|---:|---:|---:|
| history-1 | 0.1740 [0.172–0.179] | 0.1780 [0.174–0.184] | 0.1960 [0.178–0.204] | 0.1980 [0.182–0.201] | 0.1940 [0.189–0.195] |
| history-8 | 0.3350 [0.292–0.688] | 0.3890 [0.301–0.743] | 0.5260 [0.327–0.542] | 0.5140 [0.437–0.552] | 0.5140 [0.509–0.527] |
| replay-1 | 0.1650 [0.163–0.168] | 0.1660 [0.161–0.170] | 0.1840 [0.167–0.184] | 0.1790 [0.165–0.187] | 0.1780 [0.173–0.178] |
| replay-8 | 0.3665 [0.269–0.616] | 0.3895 [0.283–0.668] | 0.4830 [0.347–0.516] | 0.4760 [0.461–0.532] | 0.4800 [0.474–0.517] |

Candidate p95 change vs B / vs A, in the same row order:

| Form | History-1 | History-8 | Replay-1 | Replay-8 |
|---|---:|---:|---:|---:|
| a | +12.6% / +10.1% | +57.0% / +35.2% | +11.5% / +10.8% | +31.8% / +24.0% |
| b | +13.8% / +11.2% | +53.4% / +32.1% | +8.5% / +7.8% | +29.9% / +22.2% |
| c | +11.5% / +9.0% | +53.4% / +32.1% | +7.9% / +7.2% | +31.0% / +23.2% |

Recommendation: **none for production from this investigation**. a/b remove much of Custom access_rows and visible-list overhead, but introduce a large Generic fan-out regression: member_access 25.950/27.330 ms versus B 1.113 and A 1.531. Every retained Generic pass uses a Nested Loop with 523,776 discarded join pairs (users estimate 2, actual 1,024). c changes that to a Hash Join and 1.394 ms, but still estimates only 4 users; this is a fragile join-choice tipping point, not a demonstrated cardinality fix. Its Custom access_rows/visible-list costs are 3.007/0.871 versus A 4.929/1.472 ms, while Generic timeline is 191.599 versus B 144.268/A 184.199 and Custom counts 26.335 versus B 20.380/A 22.087. All queries in this later c batch are generally slower, so do not attribute the entire raw difference to CASE. The latency table does not demonstrate that any form clears History-8's +10% criterion under steady matched conditions. c is the best partial follow-up for fan-out, not a merge recommendation.

Unread Topic counts: **none restores the sequence bound to Index Cond**. All five retained passes in Custom/Generic/Auto keep `seq > COALESCE(tr.read_seq, p.initial_seq)` as a Filter for A/a/b/c; B has it in Index Cond. No LEAKPROOF claim or query/index change was attempted. Scalar subqueries do execute settings through InitPlans, but their unknown parameter selectivity changes planning, and per-loop gates/InitPlan reads still have costs.

Exact tested c SQL follows (investigation artifact, not a proposed production migration). a uses the same ten Organization policy replacements with plain Account equality/EXISTS; b adds the non-NULL AND guard; full literal scripts for all three remain in the external artifact directory.

```sql
BEGIN;
DROP POLICY org_isolation ON organizations;
CREATE POLICY org_isolation ON organizations FOR ALL USING (organization_id = (SELECT fukulow_current_org())) WITH CHECK (organization_id = (SELECT fukulow_current_org()));
DROP POLICY org_isolation ON users;
CREATE POLICY org_isolation ON users FOR ALL USING (organization_id = (SELECT fukulow_current_org())) WITH CHECK (organization_id = (SELECT fukulow_current_org()));
DROP POLICY org_isolation ON channels;
CREATE POLICY org_isolation ON channels FOR ALL USING (organization_id = (SELECT fukulow_current_org())) WITH CHECK (organization_id = (SELECT fukulow_current_org()));
DROP POLICY org_isolation ON channel_members;
CREATE POLICY org_isolation ON channel_members FOR ALL USING (organization_id = (SELECT fukulow_current_org())) WITH CHECK (organization_id = (SELECT fukulow_current_org()));
DROP POLICY org_isolation ON channel_message_sequences;
CREATE POLICY org_isolation ON channel_message_sequences FOR ALL USING (organization_id = (SELECT fukulow_current_org())) WITH CHECK (organization_id = (SELECT fukulow_current_org()));
DROP POLICY org_isolation ON messages;
CREATE POLICY org_isolation ON messages FOR ALL USING (organization_id = (SELECT fukulow_current_org())) WITH CHECK (organization_id = (SELECT fukulow_current_org()));
DROP POLICY org_isolation ON topics;
CREATE POLICY org_isolation ON topics FOR ALL USING (organization_id = (SELECT fukulow_current_org())) WITH CHECK (organization_id = (SELECT fukulow_current_org()));
DROP POLICY org_isolation ON channel_read_positions;
CREATE POLICY org_isolation ON channel_read_positions FOR ALL USING (organization_id = (SELECT fukulow_current_org())) WITH CHECK (organization_id = (SELECT fukulow_current_org()));
DROP POLICY org_isolation ON topic_read_positions;
CREATE POLICY org_isolation ON topic_read_positions FOR ALL USING (organization_id = (SELECT fukulow_current_org())) WITH CHECK (organization_id = (SELECT fukulow_current_org()));
DROP POLICY org_isolation ON invites;
CREATE POLICY org_isolation ON invites FOR ALL USING (organization_id = (SELECT fukulow_current_org())) WITH CHECK (organization_id = (SELECT fukulow_current_org()));
DROP POLICY account_read ON users;
DROP POLICY account_read ON organizations;
CREATE POLICY account_read ON users FOR SELECT USING (CASE WHEN (SELECT fukulow_current_account()) IS NULL THEN false ELSE account_id = (SELECT fukulow_current_account()) END);
CREATE POLICY account_read ON organizations FOR SELECT USING (CASE WHEN (SELECT fukulow_current_account()) IS NULL THEN false ELSE EXISTS (SELECT 1 FROM users u WHERE u.organization_id = organizations.organization_id AND u.account_id = (SELECT fukulow_current_account())) END);
COMMIT;
```

Semantics: every form passed the psql substitute for the requested Rust suites: 60 table×context×plan-mode cells (ten target tables, unset/Organization-only/Account-only, Custom/Generic), with expected SELECT visibility, INSERT-other denied (42501), UPDATE/DELETE-other affecting zero rows, context-free/Account-only writes denied, and Organization moves rejected (42501; users identity trigger P0001). Same-Organization other-Account Members stay hidden in Account context. Both-context SELECT union and Account-only write denial also passed. Prepared copies of the production materialized-CTE/correlated-LATERAL wrapper passed 80 alternating-Organization reads plus 80 unset follow-ups per plan mode/form on the same backend, with identical Member/Channel IDs in both Organizations. The semantic clone alone temporarily disabled Member triggers for fixture truncation and re-enabled them before seeding/checks; timing data was never changed. This is not execution of `server/src/database/tests/rls.rs` or `server/src/messages/tests/rls_statements.rs`: their SQLx fixtures recreate production policies. Full production-path assertions, cancellation/abort behavior, private-Channel authorization and Account-context performance remain unverified for these forms.

Reproduction/raw evidence (outside Git): `/private/tmp/fukulow-314-step5/mitigation/` contains `run.ts`, `case-run.ts`, `candidate-{a,b,c}.sql`, `semantics.ts`, `analyze.ts`, `summary.json`, conditions, complete plan outputs and pgbench reports. Run `node run.ts` for confirmation/a/b, then `node case-run.ts` for c; completion markers skip retained runs, so use a new external root for an independent repeat. The scripts extract schemas, migrate, apply role/grant SQL, run the unchanged seed, apply candidate SQL, collect plans and invoke `load/hot-latency.ts` with 30 seconds and 1/8 clients for candidates; passwords are ephemeral environment values. Failed fixture/setup attempts remain separately named and are excluded from summaries. No end-to-end send-load rerun, production mitigation, new dependency or LEAKPROOF/IMMUTABLE annotation. All created containers/volumes were removed; no worktree or app image was created. Shared desktop/VM, one seed, short EXPLAIN samples, one plan set per form and sequential form groups limit generalization; the original single-statement adapter is not the explicit-transaction latency harness.

### Maintainer decision: exception to the 10% criterion (#314 step 5, 2026-11-13)

The maintainer accepted the current RLS policies with this regression as a **one-time, recorded exception** to #314's 10% criterion:
- Accepted: History p95 at 8 clients 0.335 → 0.389 ms (+16.1%, about +0.05 ms per page; medians of 8 interleaved runs per side). Replay +6.3%; send throughput and send p95 0.0%.
- The causal regression rate is not established: ranges are wide (before 0.292–0.688, after 0.301–0.743 ms) and the 5 extra pairs alone favoured RLS.
- This does **not** relax the performance criterion for later changes. Small, shared-host, synthetic measurements here are not a production performance guarantee.
- Current policies stay; candidates a/b/c are not adopted; no optimisation may weaken the security guarantees.
- Follow-ups: fan-out `access_rows`/`member_access` (#354), Unread list/counts (#355), Unread Topic-count `seq` index bound (#356), History re-measurement on a stable host with realistic API-path load and query-level improvements (#357). The timeline Generic-plan cost, increased by RLS, stays tracked in #326.

## Timeline statement persistence (#326, 2026-11-14)

Purpose: prevent the shared timeline/single-Topic projection from switching to its expensive generic plan. Source: 6a87a35 plus this fix; SQL, RLS, Unread counts, indexes and responses unchanged.

Conditions: Apple M5 / 10 CPUs / 32 GiB, macOS 27.0.1 arm64; Docker 29.9.3 VM 10 CPUs / 7.748 GiB; PostgreSQL 18.6 (Debian aarch64), default shared_buffers 128MB / work_mem 4MB; Rust 1.99.0 release, SQLx 0.8.6, loopback TCP. Fresh throwaway database with current migrations/grants and unchanged `load/hot-plans/seed.sql` (#325 dataset): hot Channel 100,000 Messages, 70,000 in 2,000 Topics; Org A 10,000 Members / 50 Channels, Org B 1,000 Members / 10 Channels; 406,800 Channel positions and 2,000 measured-Member Topic positions. Current RLS enabled throughout; measured role is non-owner, NOBYPASSRLS `fukulow_app` with transaction-local Organization context.

Reproduce: migrate/grant/seed a throwaway PostgreSQL 18.6 as owner, supply its app-role `DATABASE_URL`, then run `cargo test --release -p fukulow-server --lib measure_timeline_plan_cache -- --ignored --nocapture`. The ignored probe uses production `page_sql()` and the handler's nine bindings (latest limit 51; single Topic: Topics only / limit 2). Each run holds one pooled connection for before/custom/after, clearing its statement cache between modes to represent fresh deployment connections. Each mode/variant uses REPEATABLE READ READ ONLY and the production Organization-setting helper; ten warm-ups precede 30 timed fetches. Before switches naturally to generic (35 generic / 5 custom executions after latest sampling); reference forces custom only on this measurement connection; after uses auto/non-persistent. Nearest-rank wall p50/p95 include planning, preparation and fetching, excluding transaction/context round trips, HTTP and watermark work. Buffers are root execution shared hits from a subsequent warm EXPLAIN ANALYZE BUFFERS of the cached statement (before/reference) or non-persistent query (after); planning excluded, shared reads zero in every run.

| Query / mode | p50 ms, runs 1 / 2 / 3 | p95 ms, runs 1 / 2 / 3 | Shared hits (all runs) |
|---|---:|---:|---:|
| Latest before, cached auto | 232.523 / 181.056 / 211.756 | 482.668 / 316.425 / 292.309 | 502617 |
| Latest custom reference | 31.143 / 23.510 / 28.163 | 47.813 / 26.165 / 33.014 | 3478 |
| Latest after, non-persistent auto | 24.219 / 22.628 / 29.941 | 29.557 / 24.077 / 47.700 | 3478 |
| Single Topic before, cached auto | 13.062 / 13.680 / 10.628 | 48.023 / 25.686 / 15.851 | 12409 |
| Single Topic custom reference | 1.185 / 0.784 / 1.251 | 1.581 / 1.203 / 3.557 | 267 |
| Single Topic after, non-persistent auto | 1.587 / 1.092 / 1.356 | 2.010 / 1.399 / 2.043 | 267 |

Chosen option: `.persistent(false)` on this query only, avoiding SET LOCAL's extra round trip while leaving Unread statement caching unchanged. The projection disappears from `pg_prepared_statements` in every after sample and retains custom-range buffer use. The non-ignored `timeline_and_single_topic_never_cache_a_generic_plan` guard runs both production handlers 12 times each through restricted-role RLS on one reused backend and checks no projection is retained. Temporarily removing `.persistent(false)` makes it fail with one cached projection; restoring it passes. Existing response/paging/denial/Unread tests are unchanged; full server fmt/clippy/tests passed (613 passed, 15 ignored).

Acceptance (p95 against the same run's forced-custom p95; the earlier "single Topic below 1 ms" target came from EXPLAIN Execution Time and does not apply to wall time, which includes planning and fetching; the maintainer approved the 1.5x-of-custom target for both pages on 2026-11-14, #326): latest 0.62 / 0.92 / 1.44, single Topic 1.27 / 1.16 / 0.57, all within 1.5x. Before was 10x (latest) and 12x (single Topic) slower than custom.

Limits: other AI workers ran builds and tests on this shared host during all three runs, so absolute numbers are noisy (run 3 latest p95 47.7 ms); the ratios hold in every run. Statement fetches only, not endpoint latency or capacity. The custom plan still aggregates the Channel's immutable prefix; Channel-size growth is a separate Backlog Issue because current `topics.last_seq` cannot enumerate Topics moved after W. Raw logs stay outside Git in `/private/tmp/fukulow-326/`.

## Sign-in admission under a credential flood (#196 C, 2026-11-13 JST)

Reproduce from the repository root, one run at a time, nothing else running (add `LOAD_MALLOC_MMAP_THRESHOLD=131072` for the allocator check):

```bash
LOAD_PORT=18096 SIGNIN_CONCURRENCY=64 SIGNIN_RATE=500 SIGNIN_SECONDS=60 SIGNIN_READ_RATE=2 SIGNIN_ACCOUNTS=1000 SIGNIN_IP_POOL=10000 SIGNIN_CORRECT_EVERY=10 SIGNIN_TIMEOUT_SECONDS=45 SERVER_REF=<commit> make load-signin
```

Conditions: Apple M5, 10 CPUs, 32 GiB, macOS 27 / Darwin 27.0.0; Docker 29.9.3 (10 CPUs, 7.7 GiB); Node v26.13.0; app and PostgreSQL from `load/compose.yml`, release image built per commit. 500 sign-ins/s for 60 s from at most 64 client requests in flight, over 10,000 client IPs: half wrong passwords for known Accounts, 40% unknown emails, every tenth a correct password; plus 2 Organization B reads/s. Credentials are random per run and never logged. Base = f11ba03 (merge base), pre-fix = 47280c5/1a563cf (admission after the Account lookup), fixed = 9677ca6 (admission before the lookup). Runs alternated base/branch.

| Run | Sign-ins sent | Correct succeeded | 503 | Success p95 (ms) | App RSS peak (MiB) | DB connections in use, peak | App CPU mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| base, 3 runs | 24,325–26,264 | 100% | 0 | 240–286 | 735–869 | 5–6 | 346–382% |
| pre-fix, 3 runs | 29,996–30,000 | 81–87% | 3,900–5,553 | 132–170 | 870–1,440 | 7–20 | 358–379% |
| fixed | 30,000 | 85.2% | 4,297 | 153 | 660 | 5 | 373% |
| fixed + mmap threshold | 29,991 | 83.7% | 4,353 | 143 | 90 | 5 | 356% |

Organization B reads succeeded 120/120 in every run, p95 ≤ 6.4 ms. Rejected sign-ins (429/503) answered in about 1 ms at p50. Base sent fewer sign-ins because its slower responses hit the 64 in-flight cap, so base queueing is under-reported. Base returned some 429 for unknown emails (key cap); the branch evicts idle email buckets instead.

Results:
- The branch sheds overload uniformly with 503: 13–19% of correct sign-ins are rejected under this flood, in exchange for success p95 about half of base and no unbounded queue.
- Admission before the lookup removes the DB lookup from a 503; the pre-fix runs reached 15–20 pool connections twice, the fixed run stayed at 5 (single run; one pre-fix run also stayed at 7).
- RSS: base also reached 735–869 MiB, so the growth is not new in this PR. Idle RSS 12 s after drain was 376–472 MiB without the threshold and 14 MiB with it; peak dropped from 660 to 90 MiB at equal throughput and CPU. Freed 19 MiB Argon2 blocks retained by glibc malloc explain it, not live request state.

Limits: one host, loopback, short 60 s runs, one to three runs per variant; DB connection peaks varied between runs. The client caps in-flight requests at 64, so it does not model an attacker with unbounded concurrency. The allocator setting was tested only as a run-time environment variable, not as an image default.

## WebSocket socket caps, frame budget and read buffer (#196 A, 2026-11-13 JST)

Reproduce in `server/` against a local PostgreSQL (`DATABASE_URL` set), `ulimit -n 100000`, nothing else heavy running:

```bash
MEASURE_READ_BUFFER=8192 cargo test --release --lib realtime::tests::limits::measure_idle_socket_rss_by_read_buffer -- --ignored --exact --nocapture
MEASURE_SECONDS=30 MEASURE_FLOODERS=8 cargo test --release --lib realtime::tests::limits::measure_reconnect_flood_subscribe_load -- --ignored --exact --nocapture
```

Add `MEASURE_UNLIMITED=1` to the flood run for the no-limit variant. RSS and CPU time come from `ps -o rss=,time=` on the test process, sampled 5 s and 25 s after the ready line it prints.

Conditions: Apple M5, 10 CPUs, 32 GiB, macOS 27 / Darwin 27.0.0; release test binary at this PR's head; PostgreSQL in Docker; server and loopback clients in one process. Another build/test job ran on the host during some runs.

**Idle sockets.** 10,000 subscribed idle sockets, two rounds per variant:

| Server read buffer | RSS (MiB), rounds 1 / 2 | CPU time over 20 s idle (s) |
| --- | --- | --- |
| 128 KiB (tungstenite default) | 2,693 / 2,693 | 0.64 / 0.69 |
| 16 KiB | 1,595 / 1,595 | 0.60 / 0.62 |
| 8 KiB (chosen) | 1,516 / 1,516 | 0.53 / 0.62 |
| 4 KiB | 1,477 / 1,476 | 0.55 / 0.59 |

The process also holds the 10,000 client sockets, so only differences are meaningful: 128 KiB -> 8 KiB saves about 1.15 GiB (1,177 MiB) (~120 KiB per socket); 8 KiB -> 4 KiB saves about 40 MiB.

**Reconnect flood.** One Account, 8 sockets looping subscribe/unsubscribe as fast as possible and reconnecting at once on any close or refusal, for 30 s. Meanwhile a Member of another Organization re-subscribes every 500 ms (1 s deadline). App pool in use sampled every 5 ms. Three runs per variant:

| Variant | Subscribes/s | Upgrades accepted | Upgrades refused (503) | Pool in use, peak | Other Organization ok / failed | Other p50 / p99 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| no limits | 299–306 | 8 | 0 | 5 | 58 / 0 | 24–25 / 31–40 |
| budget, upgrade admitted when empty (first version) | 15.6–15.7 | 19,059–19,848 | 0 | 5 | 56 / 0 | 35–37 / 51–56 |
| budget + refusal at upgrade when empty (chosen) | 12.1–13.8 | 247–457 | 74,611–91,552 | 5 | 23–28 / 0 | 26–37 / 35–43 |

Results:
- The budget cuts subscribe work (authorization query, two watermark transactions, replay) from ~300/s to ~13/s for a flooding Account.
- Admitting an exhausted Account turned the flood into ~660 upgrades/s, each with a session check, and the other Organization's p50 rose. Refusing at upgrade removed those connections.
- No other-Organization probe failed in any run. Its lower count with refusals is client-side: the flood and the probe share one test runtime.

Limits: one host, loopback, short runs, server and clients in one process, so absolute RSS and the probe's timing include client cost. Each refused upgrade still runs one authentication query (~3,000/s here); handshake admission and accept pacing are #212. The per-Account (32) and global (12,000) caps were not load-tested beyond the cap tests; their values come from the 10,000-socket target and the RSS above. Not a fairness guarantee between Accounts.

## Sustained write throughput (#309, 2026-11-13 JST)

Reproduce from the repository root, one mode at a time, nothing else running:

```bash
THROUGHPUT_SCENARIO=many THROUGHPUT_RATES=50,100,250,500,1000,2000,4000 THROUGHPUT_STEP_SECONDS=60 THROUGHPUT_VUS=20 THROUGHPUT_MAX_VUS=100 REQUEST_TIMEOUT_SECONDS=3 make load-throughput
THROUGHPUT_SCENARIO=hot THROUGHPUT_RATES=50,100,250,500,1000,2000,4000 THROUGHPUT_STEP_SECONDS=60 THROUGHPUT_VUS=20 THROUGHPUT_MAX_VUS=100 REQUEST_TIMEOUT_SECONDS=3 make load-throughput
```

Conditions: server and harness 6f95221 (clean). Apple M5, 10 CPUs, 32 GiB; Docker Desktop 29.9.3 VM with 10 CPUs and 7.748 GiB; k6 1.8.2 on the same host; HTTP without TLS or proxy; fresh database per mode. k6 constant-arrival-rate steps of 60 s each, 4 Members, no subscribers. `many` routes over 200 public Channels and `hot` sends to 1. Sends per second accepted inside each step's window:

| Offered/s | many: accepted/s | many: p50/p95/p99 ms | hot: accepted/s | hot: p50/p95/p99 ms |
| ---: | ---: | --- | ---: | --- |
| 50 | 50 | 3 / 5 / 6 | 50 | 3 / 4 / 6 |
| 100 | 100 | 2 / 4 / 5 | 100 | 2 / 4 / 5 |
| 250 | 250 | 1 / 3 / 5 | 250 | 1 / 2 / 3 |
| 500 | 500 | 1 / 2 / 3 | 500 | 1 / 2 / 3 |
| 1,000 | 998* | 1 / 2 / 6 | 998* | 1 / 4 / 42 |
| 2,000 | 1,996* | 1 / 4 / 8 | 1,788* | 54 / 64 / 75 |
| 4,000 | 3,968* | 5 / 21 / 36 | 1,749* | 55 / 68 / 85 |

\* k6 dropped iterations: `many` 145 / 225 / 1,881, `hot` 115 / 12,654 / 134,985. k6 drops an iteration when all 100 VUs are busy, so these steps did not run at their offered rate; dropped iterations alone cannot tell generator capacity from server response time. There were zero 429, 503, other errors and incomplete requests in any step. Both modes ran 8 top-level queries and 12 statements (including nested FK checks) per send. Peak sampled CPU, where 100% is one core: `many` app 165%, DB 254%, generator 137%; `hot` app 61%, DB 66%, generator 40%. Peak app RSS was 141 / 122 MiB.

Result: across many Channels, one node sustained about 4,000 accepted sends/s with p95 21 ms. At 4,000/s the generator used 137% CPU on the shared host and server p95 stayed low, so the generator likely set that ceiling, but this run cannot prove it. So the `docs/spec.md` "thousands of writes/s per node" target holds for spread writes on this host. One hot Channel reached about 1,750 accepted sends/s under these conditions (at most 100 VUs): p50 jumps to about 55 ms while app and DB CPU stay low. The leading hypothesis is the one-send-at-a-time-per-Channel serialization (about 0.57 ms per send), a per-Channel limit rather than a node limit; this run does not isolate it.

Limits: one run per mode on a shared single host, with the generator competing for the same CPUs. At most 100 VUs means at most 100 requests in flight, so open bursts larger than that (the #57 2,048-send burst that returned 87% 503) are not exercised here. 17-byte bodies, one Organization, no WebSocket fan-out load and no TLS. The server ceiling for `many` is unmeasured. Raw artifacts stay outside Git (`LOAD_RESULT_DIR`).

### Image default `MALLOC_MMAP_THRESHOLD_=131072` (#340, 2026-11-13 JST)

Reproduce from the repository root with the #309 write commands and the #196 C sign-in command above, without `SERVER_REF` or `LOAD_MALLOC_*` (the working-tree image applies its own default); before = f676d77, after = f676d77 plus the Dockerfile `ENV`. Same host and Docker VM as #309/#196 C; runs one at a time, before then after.

Writes (accepted/s, p50/p95/p99 ms):

| Offered/s | many before | many after | hot before | hot after |
| ---: | --- | --- | --- | --- |
| 50 | 50, 3/5/9 | 50, 3/5/10 | 50, 3/5/7 | 50, 3/5/6 |
| 250 | 248*, 1/3/61 | 250, 1/2/4 | 250, 1/2/8 | 250, 1/2/5 |
| 1,000 | 997*, 1/4/21 | 1,000*, 1/2/5 | 997*, 1/8/72 | 999*, 1/3/11 |
| 2,000 | 1,967*, 2/10/67 | 1,991*, 2/7/37 | 1,552*, 62/74/94 | 1,578*, 61/72/93 |
| 4,000 | 3,553*, 12/44/66 | 3,971*, 6/24/37 | 1,498*, 63/85/123 | 1,566*, 61/74/94 |

\* k6 dropped iterations (all VUs busy). At 100 and 500/s, after was equal or lower (worst p99 before 28/32 ms, after 3/7 ms). Zero 429, 503 and other errors in every step. Peak CPU app/DB: many 166/298% before, 169/271% after; hot 65/76% before, 65/72% after. App container memory peak: 138-145 MiB before, 14-15 MiB after (the fixture's Argon2 sign-ins no longer stay resident).

Sign-in flood with the image default: 30,000 sent, 85.8% of correct sign-ins succeeded, 4,074 503, success p95 134 ms, App RSS peak 90 MiB, idle RSS 14 MiB 12 s after drain, app CPU mean 355%, DB connections peak 4, Organization B reads 120/120 (p95 6.8 ms).

Result: no write regression; after was equal or better at every step, which is within this host's run-to-run noise (the before `many` run dropped more iterations). The sign-in run matches the #196 C "fixed + mmap threshold" row, now from the image default rather than a run-time variable.

Limits: one run per variant on a shared host; glibc (Debian bookworm) only, so a base image or libc change needs a new measurement; 60 s steps do not show long-run fragmentation.

## Bounded web message windows (#308, 2026-11-14 JST)

Source: main 68b888c plus the #308 working tree. macOS 27.0.1 / arm64, Apple M5, 10 CPUs, 32 GiB; Node 26.13.0, Vitest 5.1.0, Playwright 1.65.0 / Chromium 158.0.8127.18. Browser run: Rust 1.99.0 debug server, PostgreSQL 18.6 from the compose-pinned image on Docker Desktop 29.9.3, disposable migrated database, loopback HTTP/WebSocket, 1440×900 viewport. Runs were sequential, with no other task tests or builds running.

Named body budgets: main projections 400, one active Topic history 300, one Reply panel 200; sync 400 per watched Channel, 50 per inactive Channel in at most five LRU slots, and 600 shared across sync caches. Main/Topic budgets are shared across Channels. The 600 sync budget reserves the other 900 slots for simultaneous projection histories; it may release an older inactive slot before all five slots are full. Total history budget: 1,500 slots. Pending sends and active navigation anchors are separate; Unread keeps other-sender identity/sequence metadata, not display bodies. Topic sequence ranges and gap evidence also survive body eviction.

Reproduce with the pinned Node version, from the repository root:

```bash
MEASURE_WINDOW=1 npm --prefix web test -- src/message-window-memory.test.ts --disableConsoleIntercept
npm --prefix web run build
cargo build -p fukulow-server --bins
DATABASE_URL=<disposable-app-role-url> npm --prefix web run e2e -- message-window.spec.ts
```

Provision a fresh disposable PostgreSQL database with the role/migration steps in `.github/workflows/e2e.yml` before the browser command. The local runs used `npx --yes --package=node@26.13.0 -c '<command>'` to select the repository pin without changing dependencies. Both probes print one JSON measurement record and assert their bounds.

Controller probe (`web/src/message-window-memory.test.ts`): 2,000 initial synthetic records; ten cycles of 1,000 timed main-Channel arrivals, ten older main pages, eight Topic pages and six Reply pages (50 records/page), then Topic release, Reply dismissal and a Channel round trip. Each of the ten distinct other Channels receives another 100 untimed events before unwatch. Thus 10,000 timed arrivals, 1,000 additional events, 20 Channel changes and ten Topic/Reply visits. Transport fixtures exercise the production sync/projection controllers; they are not a server-data or browser benchmark. Timing includes dispatch plus reading main/Reply snapshots.

| Controller result | Value |
| --- | --- |
| Peak retained sync / main / Topic / Reply records | 600 / 400 / 300 / 200 |
| Peak combined retained history slots | 1,500 |
| Arrival p50 / p95 / maximum | 0.0508 / 0.1360 / 1.4417 ms |
| Main / Topic / Reply reads, including initial loads | 131 / 80 / 60 |

Browser probe (`web/e2e/message-window.spec.ts`): real endpoints seed 450 main Messages, 450 Topic Messages and a 300-Message Reply chain. After paging main beyond its cap, 2,000 arrivals use response-paced batches of eight HTTP sends; every tenth body repeats its text ten times to vary row heights. One Composer send follows, then 450 further arrivals while unpinned. The run makes six Channel round trips, repeatedly opens Topic and Reply views, pages both past their caps, refetches in both directions, and exercises Composer Up, Home/End and Arrow navigation beyond mounted rows. A 300-record Topic window and 200-record Reply window are open together. The anchor moves less than 3px during the unpinned arrival block.

| Browser result | Value |
| --- | --- |
| Mounted main / Topic / Reply rows at samples | 13 / 18 / 12 |
| Descendant DOM elements in main / Topic / Reply at samples | 139 / 188 / 129 |
| All application DOM elements with Topic and Reply open | 386 |
| 2,000 timed arrivals, HTTP submission through final DOM update | 11,603 ms |
| Mutation to next animation frame p50 / p95 (2,643 samples) | 5.1 / 14.8 ms |
| Renderer script / layout / style recalculation during timed arrivals | 2,497 / 372 / 148 ms |
| Projection/navigation reads across the complete browser workload | 43 |

The browser uses CDP cumulative CPU metrics for script/layout/style deltas; mutation-to-frame samples cover the first main view's active lifetime, including its arrival, keyboard and anchor checks. They measure frame readiness, not GPU paint time. Arrival wall time includes HTTP, PostgreSQL, WebSocket delivery and the Playwright driver. This is not a server throughput claim. Element counts include controls and spacers; row counts count mounted confirmed rows. Separate Vitest coverage windows 1,000 pending sends without dropping them, and Playwright covers first-Unread entry through 450 Messages beyond the main cap.

These results keep the approved 400/300/200 caps and 560px overscan: record and DOM counts remain bounded through the workload, with p95 mutation-to-frame time below one 60Hz frame on this machine. No API extension was needed. Limits: one run per probe, headless desktop browser and debug server; no production capacity or low-end-device claim, no heap-size bound, and no claim that sequence/ID evidence or user-authored pending sends have fixed cardinality. Cache-slot counts can include the same canonical Message in more than one store; caller-held snapshots and transient HTTP response allocations are not heap measurements. Older Reply history still requires restarting from the chain start with existing endpoints.

### #308 round-1 evidence and active-Unread remeasurement (2026-11-14 JST)

Source: `codex/message-window-308`, ede344c plus the round-1 working-tree fixes. Same macOS 27.0.1 / Apple M5 / 10 CPUs / 32 GiB host; Node 26.13.0 and Vitest 5.1.0. The final controller run was sequential, without another task build, test or load probe running. This adds evidence omitted by the original record above; that record is historical and does not establish a metadata bound.

Targets fixed before this run: keep the approved 400/300/200/50 body caps and 1,500 shared display slots; retain at most 400 Topic range objects per projection window, 400 Reply availability ranges, 400 disjoint sync ranges, 1,100 Unread records per Channel, 1,100 presented seqs per active visit and one first-Unread identity. The Unread record allowance is the union of the 400 sync, 400 main and 300 active Topic bodies, so refetched pages can still supply presentation evidence. Unread Topic scopes are capped at 400. Discarded evidence invalidates insufficient baselines and uses existing endpoints to refresh; positions never advance just to reclaim metadata. A scalar sync recovery target retains forgotten gaps until unfiltered recovery.

Reproduce with the original command:

```bash
MEASURE_WINDOW=1 npm --prefix web test -- src/message-window-memory.test.ts --disableConsoleIntercept
```

The file now runs two production-controller probes. The original navigation probe again peaked at sync/main/Topic/Reply = 600/400/300/200 and 1,500 combined display slots; main/Topic/Reply reads were 131/80/60. Arrival p50/p95/max were 0.04425/0.06246/1.01613 ms. No body cap or overscan adjustment was made.

The added probe instantiates sync, Topics, Replies **and Unread**. It starts with one Message in each of T/U, opens T's history and Reply root, and enters T's Unread scope at position 0 with one Unread. Then 100,000 arrivals alternate T/U; every T arrival is a Reply in the open chain. The same Unread visit remains active throughout. Every 1,000 arrivals it presents only the recent T rows and drains async refreshes; the unseen first Message must prevent mark-read progress. Instrumentation observes the actual private evidence/record stores, not only display snapshots. Counts are sampled after every arrival and after each async drain.

| Sampled retained-store peak | Value |
| --- | --- |
| Topic range objects / Topic evidence keys | 400 / 2 |
| Reply availability range objects | 400 |
| Unread identity/sequence records | 1,100 |
| Visit presented seqs / separately pinned first-Unread identity | 350 / 1 |
| Unread Topic scopes | 2 |
| Sync disjoint ranges in this contiguous stream | 0 |
| Main latest bodies / summary baselines / active Topic windows | 2 / 2 / 1 |
| Main Topic membership / W-relative positions / summary-through entries | 2 / 2 / 2 |
| Projection refresh jobs / persistent read slots | 2 / 4 |
| Unread summary reads / queued summaries / held Topic positions | 2 / 2 / 0 |
| Unread summary retry timers / attempt entries at samples | 0 / 0 |
| Combined retained display body slots | 904 |

At 25k/50k/75k/100k arrivals, Unread retained 942/1,080/817/955 records and presented sets held 300/340/300/300 seqs; Topic/Reply ranges were 400/400 at every point. Arrival dispatch p50/p95/max: 0.09400/0.10579/1.53954 ms. Baseline traffic is a cost of the bound: the complete probe used one main read, 819 Topic-summary reads and 313 Channel-list reads, including initial reads and the final validation. It also made one Reply read and 996 Topic-history reads; 995 of those history reads are the final refetch back to the first Message, outside the timed arrival block.

After all arrivals the visit still had boundary 0, entry Unread 1 and first-Unread seq 1, with zero mark-read requests; the refreshed T count was exactly 50,001. Refetching the evicted prefix and presenting seq 1 then made one mark-read request, persisted position 1 and recovered count 50,000 without changing the visit marker. CI regressions also hold a refresh indefinitely while 10,000 arrivals retain at most 1,100 records, limit 500 one-off Topics to 400 scope/evidence identities, and cap 1,000 disjoint sync ranges at 400 before refetching the forgotten final seq. Against the original production code, the new reproductions fail with 10,000 Unread records and 2,400 range objects for 2,400 alternating arrivals.

The four affected Playwright specs (`message-window`, `topics`, `replies`, `unread`) passed all 11 tests against the rebuilt Rust 1.99.0 debug server and a fresh, migrated, disposable PostgreSQL 18.6 instance, using only the app role. The windowing probe sampled 13/18/12 mounted main/Topic/Reply rows, 139/188/129 descendant elements, and 652 application elements with Topic and Reply open. Reply assertions explicitly scroll to early rows and fetch newer pages before checking the latest keyboard target.

### #308 same-chain anchor navigation request counts (2026-11-14 JST)

Source: `codex/message-window-308`, 2a21764 plus this working tree. macOS 27.0.1 / arm64; pinned Node 26.13.0, Vitest 5.1.0, Playwright 1.65.0 / Chromium, 1440×900 viewport. Controller and browser probes ran sequentially. The production controller uses a fake counting API with a root at seq 1 and 10,000 Replies at seq 2–10,001, default 50-record pages, exclusive `after_seq` and accurate `has_more`. Counts below exclude the initial root open and explicit paging.

| Navigation | Chain reads | First `after_seq` |
| --- | ---: | ---: |
| Cached same-chain descendant, current anchor or root | 0 | none |
| Uncached same-chain descendant at seq 9,000 | 1 | 8,975 |
| Fresh descendant open at seq 9,000 | 1 | 8,975 |

The jump returns exactly seq 8,976–9,025, including the target and context, and exposes older history. Subsequent forward pages remain contiguous with at most 200 retained history records; older navigation restarts at 0 and forward pages from there retain seq 1–200 without a cached recent suffix replacing them. Separate assertions preserve unsettled, unknown and refused Reply intents across both cached and uncached moves, retry with the original parent/key, and discard after the outcome is known or unknown. A cached move also preserves live availability evidence and continuation, including duplicate-arrival handling.

Reproduce with the pinned Node version:

```bash
npm --prefix web test -- src/replies-navigation.test.ts
npm --prefix web run build
cargo build --locked -p fukulow-server --bins
DATABASE_URL=<disposable-app-role-url> E2E_PORT=<free-port> npm --prefix web run e2e -- replies.spec.ts message-window.spec.ts
```

Browser setup: throwaway Docker PostgreSQL 18.6 using the compose-pinned digest, a free loopback port, and `fukulow-server migrate roles` / `migrate` as in `.github/workflows/e2e.yml`; tests connect only as `fukulow_app`. The new replies navigation test uses the embedded production app with mocked timeline/chain responses and a matching subscription watermark for the same 10,001-record dataset. After loading 150 Replies it navigates to a fully visible cached target: scroll displacement stays below 3px, no intermediate scroll to the top occurs, both list and row DOM nodes survive, and there are zero chain/hint reads. A cached unmounted target is revealed with zero additional reads even while a previous page is stalled. An uncached target and a fresh descendant open each take one contextual read and end with the target in view. The root also remains revealable without a read outside the retained history. Existing replies and message-window workloads use real server endpoints.

Negative checks temporarily substituted the original `replies.ts` from 2a21764, restoring the working source afterwards. All six navigation/retention controller regressions failed; the uncached seq-9,000 jump made 180 sequential reads (181 including the initial root open). The browser regression failed with a 109px cached-navigation scroll displacement against its <3px assertion. Limits: synthetic immutable records, one desktop browser and no request latency or server throughput measurement; these are request-count and scroll regressions. Older traversal and explicit latest navigation still use existing forward pages and can require many reads. No API or server change, body-budget increase or overscan adjustment is involved.

Limits: one final controller run; these are retained-store cardinalities, not a process heap/RSS bound or a controlled latency comparison. The full fixture history, timing samples, caller-held snapshots, transient HTTP/fixture allocations and microtask-only peaks are excluded. Weak baseline-identity sets do not strongly retain old baselines. Pending sends and authored drafts remain exempt; Channel cardinality is not capped by this probe. Cursor-gap recovery, stale/denied responses, P4 merge and parent-eviction retry/discard have separate CI tests. The browser recheck proves the exercised viewport/navigation behavior, not low-end-device or production capacity.

## Organization activity periodic REST reconciliation (#307 item 5, 2026-11-14 JST)

Conditions: Apple M5, 10 CPUs, 32 GiB, macOS 27.0.1; Docker 29.9.3, VM 10 CPUs / 7.748 GiB. Pinned PostgreSQL 18.6; application Docker release build, Rust 1.99.0 and Node 26.13.0, image `sha256:f64d067475f426aec033d8aba546cf7b196d931cef27ca6aa5adcd33089d0b43`; default image allocator settings, 20-connection restricted `fukulow_app` pool. Direct Docker bridge HTTP, no proxy or TLS. Four k6 1.8.2 generators, one VU each, 2,500 sockets each, disjoint socket ranges, one Account/Session per 32 sockets (313 total); production socket caps unchanged. Generators use nofile 65,536 and source-port range 1024–65535. Each opens batches of 100 every 500 ms. No build/test from this worktree ran during the measurement; unrelated host activity was uncontrolled.

Dataset: one Organization, 313 active non-Guest Members, 10 public Channels, one Topic and one Message. Held targets: all 10,000 connections hold the Channel list and Organization Capabilities; disjoint groups of 2,500 additionally hold the Organization Member directory, a Channel member list, main-scope Topic summaries, or a Topic summary. Exactly 30,000 held targets; no unheld target requests. `load/activity.ts` executes the production `createActivity` / `createActivityTarget` scheduler, including ready reconciliation, first offset uniform over 30 s, later 30 s + 0–2 s jitter, 200 ms debounce and retry bounds. No sends occur in this periodic-load window.

All four generators reported 2,500 registered/live sockets, with a common 10,000-socket interval of **92.056 s**. Each continued for 95 s after its ready condition. Zero request errors, unexpected socket closes or HTTP failures; every sampled HTTP result was 200. Total REST completions: **128,220** (29,790 ready, 30,000 first periodic, 68,430 later periodic). Early periodic demand coalesced some ready requests. A common steady interval, starting 35 s after the last full-ready condition and ending 1 s before the first socket close, contained **54,153 requests / 56.056 s = 966.05 requests/s**. Its target counts were Channel lists 18,051, Capabilities 18,051, directories 4,521, Channel member lists 4,526, main summaries 4,471 and Topic summaries 4,533.

| Observation (milliseconds) | Samples | Min | p50 | p95 | p99 | Max |
|---|---:|---:|---:|---:|---:|---:|
| First periodic scheduled offset per socket | 10,000 | 6 | 14,890 | 28,450 | 29,687 | 30,001 |
| First periodic Channel-list request offset (includes debounce) | 10,000 | 200 | 15,091 | 28,650 | 29,887 | 30,203 |
| Later periodic schedule interval | 22,886 | 30,000 | 31,003 | 31,904 | 31,981 | 32,001 |
| First periodic REST round trip, all held targets | 30,000 | 0 | 1 | 13 | 31 | 101 |
| Later periodic REST round trip, all held targets | 68,430 | 0 | 1 | 2 | 5 | 58 |

First-offset 5 s buckets across 0–30 s: **1,685 / 1,608 / 1,740 / 1,649 / 1,643 / 1,675**. The 1 ms overshoot reflects timer scheduling; request offsets additionally include debounce. App-only sampled peak Docker CPU was **46.8%** (100% = one CPU), memory **264.2 MiB**; the pool retained 20 app connections. Resource sampling began after all sockets registered, so these are sampled steady peaks, excluding startup peaks and generator/database memory.

Assessment: retain the provisional **30 s** period, 200 ms debounce, 0–2 s reset jitter and 256-key buffer. This sample has substantial REST latency headroom; it does not establish capacity for large histories/directories, more held targets, concurrent mutation-driven refetches, TLS, WANs or other hardware. It is a single small-data run, with mixed targets, four generator loops, millisecond clock resolution and only about three periodic passes per socket; no before/after or worst-case claim. Multi-sender notice correctness is checked separately, not measured by this no-send REST window.

Two earlier attempts are excluded from these figures. Docker-to-host forwarding produced connection refusals; its concurrent gauge also incorrectly decremented failed handshakes (fixed before the direct runs), so its 4,341 registrations do not prove a concurrent scale. One direct-network generator then exhausted source ports (`cannot assign requested address`), reaching a measured peak of 8,500 sockets before interruption. Four direct generators with wider source-port ranges removed those generator limits and reached 10,000 without changing the 30 s product period.

Reproduce: build the repository Dockerfile; start an isolated migrated PostgreSQL/app pair on one Docker network; run `ACTIVITY_DB_CONTAINER=<throwaway-postgres> ACTIVITY_SEED_OUT=<outside-checkout>/seed.json node load/activity-seed.ts`. Run four `grafana/k6:1.8.2` containers on that network with the seed mounted at `/seed.json`, the checkout at `/work:ro`, an individual writable `/output`, `--ulimit nofile=65536:65536`, `--sysctl net.ipv4.ip_local_port_range='1024 65535'`, `BASE_URL=http://<app>:8080`, `ACTIVITY_SOCKETS=2500`, `ACTIVITY_OFFSET=0|2500|5000|7500`, `ACTIVITY_CONNECT_INTERVAL_MS=500`, and `ACTIVITY_SECONDS=95`; command `run --out json=/output/metrics.json /work/load/activity.ts`. Artifacts outside Git: `/private/tmp/fukulow-307-load-shards` contains per-generator metrics/summaries, combined percentiles, source patch, metadata and resource samples; the earlier attempts are `/private/tmp/fukulow-307-load` and `/private/tmp/fukulow-307-load-direct`. Credentials exist only in the disposable database and a mode-0600 external seed file; no response bodies or credentials are recorded in the metrics.

### #307 multi-sender coalescing probe (2026-11-14 JST)

Separate from the no-send O5 window above: `DATABASE_URL=<throwaway-admin> cargo test --locked --release --lib realtime::tests::activity::measure_multi_sender_activity_batching -- --ignored --exact --nocapture`. Same host and PostgreSQL 18.6; native Rust 1.99.0 release test/router and loopback clients in one process, restricted app pool capped at **5**. This fixture deliberately lifts socket/control caps to 100,000 so 1,000 reader sockets can share one test Member; production per-Account/global-cap behavior is not measured here. Two sender Members each have two sockets; no Message subscriptions exist.

Pause after the first committed send's recipient authorization, commit Bob/Alice/Bob sends while that batch is held, then release. **4 commits, 1,004 sockets, exactly 2 batched recipient queries** (one frozen query plus one pending batch). Every Alice socket obtained Bob's eligible seq 4; every Bob socket obtained Alice's eligible seq 3; all 1,000 reader sockets obtained seq 4. No Message body stream was involved. Release-to-final-eligible-notice latency across the 1,004 sockets: **p50 17.290 ms, p95 19.270 ms, p99 19.426 ms, max 19.464 ms**. The test passed; SQLx reported a transient test-database cleanup warning while closing sockets, and the throwaway container is removed after validation.

Limits: one artificially paused/coalesced batch sample with tiny bodies; this establishes the bounded batch/query behavior under two senders, not sustained throughput, natural batching frequency, production socket-cap fairness or 10,000-socket mutation fan-out capacity. Raw artifact: `/private/tmp/fukulow-307-batch-measurement.log`. No buffer/debounce/jitter tuning is justified by this probe.

### #307 final-source confirmation (2026-11-14 JST)

Repeat after the final registration-id, access-transition ordering, target coverage and retry fixes. Final Docker image `sha256:f4bb0b7502596022e4dbca60f6dee82f650899e8aafe9d643a25660da50f4b4b`; the same host, pinned tools, restricted 20-connection app pool, direct Docker network, four generators, production socket caps, 95 s after each generator's ready condition, and exactly the same 30,000-held-target mix as above. No worktree builds/tests ran during the measurement. Clarification for both records: the dataset description identifies the measured Organization; the disposable database also contained an idle E2E Organization. Before this repeat, database totals were 2 Organizations, 1,122 Channels, 358 Members and 673 Messages; the measured Organization still contained exactly 313 Members, 10 Channels and 1 Message/Topic. The preceding 12 Compose E2E tests ran against this final app image and Caddy, then that stack was stopped before measurement.

All four generators exited **0**, each with 2,500 ready/live sockets. Common 10,000-socket interval: **95.478 s**; **zero** request errors, unexpected closes or HTTP failures. REST completions: **128,544** (29,778 ready, 30,000 first periodic, 68,766 later periodic). The common steady interval contained **57,549 requests / 59.478 s = 967.57 requests/s**: Channel lists 19,183, Capabilities 19,183, directories 4,798, Channel member lists 4,789, main summaries 4,794 and Topic summaries 4,802.

| Observation (milliseconds) | Samples | Min | p50 | p95 | p99 | Max |
|---|---:|---:|---:|---:|---:|---:|
| First periodic scheduled offset per socket | 10,000 | 2 | 14,524 | 28,475 | 29,629 | 30,002 |
| First periodic Channel-list request offset (includes debounce) | 10,000 | 200 | 14,724 | 28,676 | 29,830 | 30,203 |
| Later periodic schedule interval | 22,976 | 30,000 | 30,987 | 31,899 | 31,980 | 32,003 |
| First periodic REST round trip, all held targets | 30,000 | 0 | 1 | 36 | 101 | 195 |
| Later periodic REST round trip, all held targets | 68,766 | 0 | 1 | 2 | 3 | 124 |

First-offset 5 s buckets: **1,756 / 1,722 / 1,680 / 1,579 / 1,633 / 1,630**. App sampled peak CPU **34.77%**, memory **285.2 MiB**; app pool **20** connections. The larger first-run tail includes overlap with ready reconciliation; this is not an isolated endpoint benchmark. Retain **30 s**: steady load and latency agree with the earlier run, with no evidence requiring a period/debounce/jitter/buffer adjustment. The earlier small-data, mixed-target, same-host, HTTP-only and no-concurrent-mutation limits still apply; this does not establish 10,000-socket mutation fan-out capacity. Raw per-generator metrics, exit codes, combined statistics, resource samples, database counts, final image metadata and measured source snapshots are in `/private/tmp/fukulow-307-load-final`; reproduce with the four-generator command above.
## Web first-paint and timeline waterfall (#345, 2026-11-14 JST)

Purpose: measure where time goes between opening the web app and seeing a usable timeline across cache states, network conditions and entry URLs before choosing among first-paint proposals.

Environment and commit: `c30f79d8177fc0645159a11b98fc5d5abf97f3a5` (`antigravity/first-paint-345`, zero production code changes). Host: Apple M5 (10 CPUs, 32 GiB RAM), macOS 27.0.1 (`darwin 27.0.0`, `arm64`), Docker 29.9.3, Node v26.8.1, Playwright 1.65.0 / Chromium (1280×800 viewport, set in the script). Stack: production multi-stage image served by `docker compose --profile caddy up` (Caddy 2.11.9, HTTPS `tls internal`, HTTP/2, `encode zstd gzip`, `Cache-Control: public, max-age=31536000, immutable` on `/assets/*`), PostgreSQL `18.6 (Debian 18.6-1.pgdg13+2)`.

Dataset (`load/hot-plans/seed.sql`, #325 scale): Organization A (`00000000-0000-4000-8000-00000000000a`) with 10,000 Members, 40 public Channels and 10 private Channels. Signed in as Member 2 (`m2@a.invalid`), who is a member of all 50 Channels (50 visible Channels). The first visible and directly opened Channel is `channel-1` (`386df2c5-c664-ee3d-2a08-b1c9f0a0275c`) with 100,000 Messages across 2,000 Topics (50 Messages/Topic); the other 49 Channels hold 2,000 Messages across 50 Topics each. Because `load/hot-plans/seed.sql` inserts non-Argon2 placeholder hashes, the script creates a throwaway account via `POST /api/v1/setup` before running `load/hot-plans/seed.sql` and copies its Argon2 `password_hash` to `m2@a.invalid` (same pattern as `load/signin.ts`), then running `ANALYZE`.

Matrix and method: 8 cells × 10 runs (after 12 warm-up navigations to warm OS/PostgreSQL buffers and SQLx prepared-statement caches):
- Cache: Cold (`Network.clearBrowserCache` before navigation, new page) vs Warm (priming navigation in the same browser context, then measured reload; Chromium trusts Caddy's TLS SPKI via `--ignore-certificate-errors-spki-list` so immutable `/assets/*` hit disk/memory cache with 0 transfer bytes).
- Network: Unthrottled vs CDP `Network.emulateNetworkConditions` (`latency: 150` ms RTT, `downloadThroughput: 200000` B/s = 1.6 Mbps, `uploadThroughput: 93750` B/s = 750 kbps).
- URL: `/` vs direct Channel URL `/o/00000000-0000-4000-8000-00000000000a/c/386df2c5-c664-ee3d-2a08-b1c9f0a0275c`.
- Instrumentation: injected via Playwright `context.addInitScript` only (Navigation/Resource/Paint Timing, `MutationObserver` on `#app` and `.timeline-list .timeline-list__item`, `window.fetch` and `window.WebSocket` wrappers). Because `index.html` ships an empty `<div id="app"></div>` with external CSS/JS, blank-screen duration equals First Contentful Paint (FCP).

Reproduce (self-contained: builds image, starts `fukulow-fp345` Caddy stack on ephemeral ports, seeds DB, runs 80 navigations, writes `results.json` to `fukulow-345` under `os.tmpdir()` or to `FIRST_PAINT_OUT`, and tears down `down -v`):

```bash
node web/scripts/first-paint.ts
```

### Page-level metrics (ms, `p50 / p95` across 10 runs per cell)

With 10 runs, nearest-rank p95 is the 10th value: every p95 below is the slowest run of its cell and can come from a single run.

| URL | Network | Cache | `index.html` TTFB | JS/CSS End | App Mount | FCP / Blank Screen | WS `subscribed` | Timeline Visible | Asset Transfer (B) |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| `/` | Unthrottled | Cold | 2.1 / 2.4 | 8.9 / 11.1 | 17.5 / 19.5 | 28.0 / 32.0 | 142.5 / 272.9 | 129.9 / 263.8 | 92,187 / 92,281 |
| `/` | Unthrottled | Warm | 1.2 / 1.3 | 3.5 / 3.5 | 14.8 / 15.4 | 28.0 / 28.0 | 141.2 / 270.6 | 130.1 / 260.2 | 0 / 0 |
| `/o/:org/c/:channel` | Unthrottled | Cold | 2.1 / 2.3 | 8.8 / 10.4 | 17.2 / 18.7 | 28.0 / 32.0 | 130.5 / 266.2 | 120.9 / 252.7 | 92,203 / 92,256 |
| `/o/:org/c/:channel` | Unthrottled | Warm | 1.2 / 1.3 | 3.4 / 3.6 | 14.8 / 15.3 | 28.0 / 28.0 | 127.4 / 265.0 | 119.1 / 253.1 | 0 / 0 |
| `/` | Throttled (150 ms, 1.6 Mbps) | Cold | 152.9 / 153.3 | 790.2 / 804.3 | 808.1 / 822.0 | 828.0 / 836.0 | 2130.1 / 2153.6 | 2091.4 / 2106.4 | 92,187 / 92,208 |
| `/` | Throttled (150 ms, 1.6 Mbps) | Warm | 150.4 / 150.7 | 170.3 / 178.6 | 187.3 / 201.3 | 208.0 / 220.0 | 1522.4 / 1567.7 | 1471.2 / 1512.4 | 0 / 0 |
| `/o/:org/c/:channel` | Throttled (150 ms, 1.6 Mbps) | Cold | 153.1 / 153.8 | 795.4 / 804.6 | 808.2 / 824.2 | 828.0 / 848.0 | 2130.4 / 2155.2 | 2077.5 / 2108.3 | 92,187 / 92,216 |
| `/o/:org/c/:channel` | Throttled (150 ms, 1.6 Mbps) | Warm | 150.4 / 150.6 | 163.6 / 174.2 | 185.9 / 198.6 | 200.0 / 216.0 | 1508.0 / 1539.7 | 1457.3 / 1485.7 | 0 / 0 |

Static bundle sizes over the wire (compressed by Caddy): `index.html` 756 B, CSS (`index-*.css`) ~7.5 KB (finishes at 6.9–7.2 ms unthrottled cold, 385.9–390.6 ms throttled cold), JS (`index-*.js`) ~84.7 KB (finishes at 8.8–8.9 ms unthrottled cold, 790.2–795.4 ms throttled cold).

### API request waterfall before timeline is visible (ms from `navigationStart`, `p50 / p95`)

The browser shows time order only, not which response a request waited for. The "Latest ended before start" column (`latestEndedBefore` in `results.json`) names the latest API request that finished before this one started; it is not a dependency.

Dependencies read from the source at the measured commit (not measured):
- `GET /api/v1/me` -> `GET /api/v1/orgs/{org}/me`: `auth.svelte.ts` shows the app after `getMe()`, and `selectOrganization()` then awaits the Organization.
- `GET /api/v1/orgs/{org}/me` -> `channels`, `members` and the session: `selectOrganization()` opens the session (`session.ts`, which calls `channels.load()`) and starts `members.load()` only after that response.
- `channels` -> `timeline`: `channels.ts` selects a Channel when the list arrives, and `Workspace.svelte` applies the URL's Channel only once the list is `ready`; the selection then calls `sync.watch()`, which fetches the timeline. This holds for direct Channel URLs too.
- `channels #2` / `#3` are Unread list refreshes (`unread.ts` `refresh()`). Their triggering response was not traced; `#3` following `#2` is time order only.

The timing in all 8 cells is consistent with the critical path `me` -> `orgs/{org}/me` -> `channels` -> `timeline`.

Representative cells (`/` vs `/o/:org/c/:channel`, Cold cache):

| Cell | Request (in start order) | Runs before timeline | Latest ended before start (time order) | Start (ms) | End (ms) | Duration (ms) | Transfer (B) |
|---|---|---:|---|---:|---:|---:|---:|
| `/` Unthrottled Cold | `GET /api/v1/me` | 10/10 | — | 15.6 / 17.5 | 24.7 / 27.1 | 9.2 / 9.6 | 702 |
| | `GET /api/v1/orgs/{org}/me` | 10/10 | `GET /api/v1/me` | 24.9 / 27.3 | 26.9 / 29.3 | 1.9 / 2.1 | 709 |
| | `GET /api/v1/orgs/{org}/channels` | 10/10 | `GET /api/v1/orgs/{org}/me` | 28.3 / 30.8 | 84.4 / 88.2 | 55.5 / 59.3 | 19,715 |
| | `GET /api/v1/orgs/{org}/members` | 10/10 | `GET /api/v1/orgs/{org}/me` | 28.6 / 31.0 | 58.7 / 62.3 | 30.0 / 33.9 | 829,006 |
| | `GET /api/v1/orgs/{org}/channels #2` | 10/10 | `GET /api/v1/orgs/{org}/me` | 31.2 / 33.8 | 91.4 / 95.7 | 59.9 / 63.9 | 19,715 |
| | `GET /api/v1/orgs/{org}/channels/{channel}/timeline` | 10/10 | `GET /api/v1/orgs/{org}/channels` | 90.9 / 94.6 | 121.3 / 255.0 | 31.9 / 163.0 | 21,455 |
| | `GET /api/v1/orgs/{org}/channels #3` | 4/10 | `GET /api/v1/orgs/{org}/channels #2` | 92.2 / 96.6 | 119.6 / 139.7 | 34.9 / 44.7 | 19,715 |
| `/o/:org/c/:channel` Unthrottled Cold | `GET /api/v1/me` | 10/10 | — | 15.4 / 16.8 | 24.5 / 26.1 | 9.2 / 9.4 | 702 |
| | `GET /api/v1/orgs/{org}/me` | 10/10 | `GET /api/v1/me` | 24.7 / 26.3 | 26.7 / 28.4 | 1.9 / 2.8 | 709 |
| | `GET /api/v1/orgs/{org}/channels` | 10/10 | `GET /api/v1/orgs/{org}/me` | 28.2 / 29.9 | 78.9 / 82.3 | 50.7 / 53.1 | 19,715 |
| | `GET /api/v1/orgs/{org}/members` | 10/10 | `GET /api/v1/orgs/{org}/me` | 28.4 / 30.1 | 53.9 / 65.6 | 25.0 / 37.7 | 829,006 |
| | `GET /api/v1/orgs/{org}/channels #2` | 10/10 | `GET /api/v1/orgs/{org}/me` | 49.1 / 51.5 | 84.8 / 94.5 | 34.4 / 46.0 | 19,715 |
| | `GET /api/v1/orgs/{org}/channels/{channel}/timeline` | 10/10 | `GET /api/v1/orgs/{org}/channels` | 82.0 / 86.1 | 112.5 / 241.4 | 31.2 / 157.5 | 21,455 |
| | `GET /api/v1/orgs/{org}/channels #3` | 5/10 | `GET /api/v1/orgs/{org}/channels #2` | 85.7 / 95.4 | 108.6 / 125.5 | 22.0 / 40.6 | 19,715 |
| `/` Throttled Cold | `GET /api/v1/me` | 10/10 | — | 804.2 / 817.4 | 970.4 / 985.3 | 166.4 / 171.9 | 702 |
| | `GET /api/v1/orgs/{org}/me` | 10/10 | `GET /api/v1/me` | 971.2 / 986.2 | 1133.7 / 1147.9 | 161.3 / 164.5 | 709 |
| | `GET /api/v1/orgs/{org}/channels` | 10/10 | `GET /api/v1/orgs/{org}/me` | 1138.9 / 1152.0 | 1578.6 / 1598.3 | 440.8 / 455.8 | 19,715 |
| | `GET /api/v1/orgs/{org}/members` | 0/10 (in flight) | `GET /api/v1/orgs/{org}/me` | 1139.5 / 1152.7 | 6106.8 / 6203.7 | 4967.4 / 5060.9 | 829,006 |
| | `GET /api/v1/orgs/{org}/channels #2` | 10/10 | `GET /api/v1/orgs/{org}/me` | 1146.5 / 1160.4 | 1594.1 / 1611.0 | 450.6 / 466.0 | 19,715 |
| | `GET /api/v1/orgs/{org}/channels #3` | 10/10 | `GET /api/v1/orgs/{org}/channels #2` | 1596.1 / 1612.4 | 2035.4 / 2051.4 | 439.6 / 443.5 | 19,715 |
| | `GET /api/v1/orgs/{org}/channels/{channel}/timeline` | 10/10 | `GET /api/v1/orgs/{org}/channels` | 1599.1 / 1618.7 | 2070.7 / 2087.5 | 468.0 / 478.9 | 21,455 |
| `/o/:org/c/:channel` Throttled Cold | `GET /api/v1/me` | 10/10 | — | 803.8 / 819.1 | 970.0 / 986.8 | 163.8 / 168.4 | 702 |
| | `GET /api/v1/orgs/{org}/me` | 10/10 | `GET /api/v1/me` | 970.6 / 987.5 | 1134.6 / 1151.2 | 162.9 / 165.7 | 709 |
| | `GET /api/v1/orgs/{org}/channels` | 10/10 | `GET /api/v1/orgs/{org}/me` | 1139.4 / 1156.1 | 1575.8 / 1591.0 | 437.9 / 446.3 | 19,715 |
| | `GET /api/v1/orgs/{org}/members` | 0/10 (in flight) | `GET /api/v1/orgs/{org}/me` | 1140.0 / 1156.7 | 6105.7 / 6120.1 | 4965.5 / 4974.2 | 829,006 |
| | `GET /api/v1/orgs/{org}/channels #2` | 10/10 | `GET /api/v1/orgs/{org}/me` | 1156.8 / 1176.2 | 1592.3 / 1613.1 | 438.0 / 445.9 | 19,715 |
| | `GET /api/v1/orgs/{org}/channels/{channel}/timeline` | 10/10 | `GET /api/v1/orgs/{org}/channels` | 1584.1 / 1602.6 | 2057.5 / 2088.1 | 468.5 / 485.5 | 21,455 |
| | `GET /api/v1/orgs/{org}/channels #3` | 10/10 | `GET /api/v1/orgs/{org}/channels #2` | 1594.6 / 1615.0 | 2035.1 / 2055.9 | 440.9 / 442.6 | 19,715 |

### Key waterfall findings

1. **Four-step sequential API chain even on direct Channel URLs**: Opening `/o/:org/c/:channel` still runs `GET /api/v1/me` -> `GET /api/v1/orgs/{org}/me` -> `GET /api/v1/orgs/{org}/channels` -> `GET /api/v1/orgs/{org}/channels/{channel}/timeline` one after another. The dependencies come from the source (see above); the measurement shows only that each step started after the previous one ended. On the 150 ms RTT / 1.6 Mbps profile, this post-mount serial chain takes ~1,270 ms (`185.9 ms` mount -> `1,457.3 ms` timeline visible on warm cache).
2. **Duplicate `channels` calls and a 10,000-member download saturate the link and DB during bootstrap**: Every page load fires `GET /api/v1/orgs/{org}/channels` 3–4 times (`channels.load()` in `session.ts` plus 2–3 `unread` refreshes on discovery/scope entry, each 19.7 KB compressed and ~51–60 ms server time for `unread.visible_list` + `unread.list_counts`) and unconditionally starts `GET /api/v1/orgs/{org}/members` (all 10,000 Members = 829 KB compressed, taking 4,967 ms on 1.6 Mbps and competing with `channels` and `timeline` on the downlink).
3. **One slow timeline run per unthrottled cell, and cold blank screen**: Unthrottled, `GET .../timeline` takes 30.8–31.9 ms at p50. In each unthrottled cell exactly 1 of 10 runs took 157–163 ms and the other 9 took 28–41 ms, so the p95 (157.3–163.0 ms) is that single run. It accounts for the p50 -> p95 jump in `timelineVisibleMs` (119–130 ms vs 253–264 ms). None of the 40 throttled runs shows such a tail (454–488 ms). This run captured no server plans. That the slow run is #326's generic plan is an estimate from the existing #326 statement-level DB measurements (generic plan about 10x the custom plan), not observed here. On cold throttled visits, the screen is blank for 828 ms p50 (836–848 ms p95) until the 84.7 KB JS bundle downloads and mounts `#app`.

Limits: local loopback Docker stack on a developer Mac (says nothing about VPS network/CPU latency). PR #375 (#326 timeline query fix) is not merged on this base commit, so any generic-plan timeline cost is included in `timeline` and `timelineVisibleMs`. 10 runs per cell bound only the median; a tail seen in one run per cell is not a stable p95. Other AI workers and containers may run on the same host. This run saved its raw per-run JSON outside the repository at `/private/tmp/fukulow-345/results.json`; the script now defaults to `os.tmpdir()`.

## Invite list expiry range and Organization locking (#303, 2026-11-14 JST)

Conditions: this Mac, Apple M5 / 10 CPUs / 32 GiB, macOS 27.0.1; Docker 29.9.3, VM 10 CPUs / 7.748 GiB; pinned repository PostgreSQL 18.6, shared_buffers 128 MiB, work_mem 4 MiB, effective_cache_size 4 GiB, max_connections 100, random_page_cost 4, jit/fsync/synchronous_commit on. Rust 1.99.0 release tests, Node 26.13.0, source 3b36d69 plus the expiry-range patch. Restricted non-owning NOBYPASSRLS app role; owner-only seeding/DDL. Local Docker DB transport, in-process Router for operation requests, no HTTP network/TLS/WebSockets.

Dataset: measured Organization with 10k/100k/1M expired Invites preceding 260 live, five accepted and five revoked; every twentieth row Owner-Role. Another Organization initially holds 10k expired plus the same 270 mixed rows; its creation controls add 1,200 live rows over the run. VACUUM ANALYZE precedes each scale; ten warm-ups then 100 sequential samples per Role/page/variant; nearest-rank percentiles. List transaction timings include context, Organization/actor locks, lookups, fetch and commit/cleanup, excluding HTTP auth/JSON. Owner first-page ms (p50 / p95 / p99):

| Expired | Creation-order index / clock-only predicate | Expiry index / stable bound plus clock check |
|---:|---:|---:|
| 10000 | 2.28 / 2.57 / 3.73 | 1.73 / 2.59 / 3.87 |
| 100000 | 8.21 / 8.56 / 8.73 | 1.68 / 2.15 / 3.46 |
| 1000000 | 100.41 / 135.79 / 147.55 | 1.68 / 2.00 / 2.58 |

At 1M expired, Admin first-page p50/p95/p99 was 102.48/107.32/110.87 -> 1.67/1.89/2.00 ms; Owner expired-anchor continuation 38.07/43.95/47.15 -> 1.86/2.09/2.16 ms. EXPLAIN ANALYZE BUFFERS covers Owner/Admin first pages, live/expired cursor pages and both anchor lookups, including forced generic plans: before discards up to 1M expired rows, fixed uses an expiry index range and sorts live candidates. Opaque and id/time anchors remain indexed independently of lifecycle.

Four concurrent Owner-list bursts per operation, 100 successful Router requests each, timer starting after the first list acquires its Organization/actor locks: at 1M expired, Invite-create idle 2.34/3.00/4.00 ms versus burst 212.92/429.17/448.61; fixed idle 2.20/2.51/3.12 versus burst 2.68/4.78/5.43. Accept/revoke/Role-change burst p99 fell from 472.25/427.51/407.15 to 6.17/4.51/6.93 ms. These share Organization NO KEY UPDATE; lists retain actor SHARE too. Sign-in has no direct Organization-row conflict, but burst p50 rose 13.22 -> 24.81 ms before (fixed 12.29 -> 12.05); resource contention can affect compatible operations. Public sends and other-Organization create controls were also measured, preserving production admission limits (one send per fresh Member).

Tradeoff control, two other Organizations each with 1k expired + 270 mixed rows: 100k all-live Invites, first-page transaction p50/p95/p99 1.56/1.69/4.15 -> 39.77/41.19/41.58 ms. Dropping the creation-order index makes work depend on the live set; page size does not bound scan work. This supports fixing expired-history lock amplification here while documenting the live-sort cost; #223 remains storage cleanup and must preserve existing cursor anchors.

Reproduce both probes and optional #385-first migration test with INVITE_DM_MIGRATIONS=/path/to/codex-151/server/migrations node load/invite-scan.ts, using pinned Node; requires Docker, sqlx CLI and Rust. The script owns/removes its randomly named/ported DB container and anonymous volumes. INVITE_SAMPLES defaults to 100; INVITE_COUNTS to 10000,100000,1000000. Exact production after SQL, original before SQL, trimmed/full plans and distributions come from ignored Rust probes. Main raw artifacts: /var/folders/_0/jyg6ltzd6rd3k10yg_bp97x00000gn/T/fukulow-invite-scan-KnHEHt; live control: /private/tmp/invite-303-live.log. Limits: one warm/OS-cached shared-host run, ordered variants, 100-sample approximate tails, up to four lists per burst rather than sustained saturation; separate list/Router pools; no own concurrent builds during timing, other host activity uncontrolled. No VPS, disk-cold, production-capacity or fixed latency guarantee.

## #378 production-domain crate split: Mac build reference (2026-11-15)

2026-11-15, source `9237a90865319c819d6a6faf986fa6c2192f1b38` (local `origin/main`). Mac reference only, not a formal performance record: Apple M5, 10 physical / 10 logical CPU cores, 32 GiB RAM, macOS 27.0.1, native `aarch64-apple-darwin`. `rust-toolchain.toml` pins Rust 1.99.0; installed rustc 1.99.0 (b940084d7, LLVM 23.1.1). Default dev/test profiles (unoptimized + debuginfo, incremental enabled; workspace Argon2/blake2 opt-level 3 overrides); default release profile (optimized, incremental disabled). Cargo default jobs=10; no RUSTFLAGS, compiler wrapper, build-target, jobs or incremental environment override.

Wall time measured around sequential Cargo child processes with Node performance.now; no test execution or database setup. Every clean command used a different initially absent CARGO_TARGET_DIR under `/private/tmp/codex-378-target` (`dev`, `release`, `test`, `timings`); registry/source caches were reused and OS filesystem caches were not flushed. Existing production/test workspace selection was unchanged. Real SPA assets were prebuilt (locked npm install; also rebuilt with pinned Node 26.13.0 before incremental samples). Incremental commands reused their own clean dev/test directories. Before each of three runs per file/command, only that file's mtime was touched; content was unchanged and original atime/mtime were restored afterward. No untimed incremental warm-up or discarded runs; logs confirm fukulow-server recompiled in all 18 samples.

| Clean command (one run each, seconds) | Wall time |
| --- | ---: |
| `cargo build --locked` (dev) | 20.751 |
| `cargo build --release --locked` | 32.961 |
| `cargo test --no-run --locked` | 52.792 |

| Touched file | Cargo command (+ `--locked`) | Three runs (s) | Median (s) |
| --- | --- | --- | ---: |
| `server/src/auth/password.rs` | build | 2.064, 1.155, 1.124 | 1.155 |
| `server/src/auth/password.rs` | test --no-run | 6.795, 5.775, 6.867 | 6.795 |
| `server/src/realtime/origin.rs` | build | 1.195, 1.181, 1.147 | 1.181 |
| `server/src/realtime/origin.rs` | test --no-run | 5.978, 5.853, 5.399 | 5.853 |
| `server/src/lib.rs` | build | 1.217, 1.151, 1.281 | 1.217 |
| `server/src/lib.rs` | test --no-run | 5.435, 5.470, 5.369 | 5.435 |

Separate clean `cargo build --timings --locked`: 18.982 s process wall time (Cargo chart 18.9 s; 275 dirty units, zero fresh, jobs=10). Server library: start 12.66 s, duration 5.50 s = 3.22 s frontend + 2.28 s codegen (59%/41%). Server binary 0.79 s and OpenAPI binary 0.18 s start together at 18.16 s; server work occupies a 6.29 s tail, about 33% of the chart span, with a 12.66 s dependency/startup prefix. Aggregate overlapping unit durations: external dependencies 104.13 s, server targets 6.47 s, test macro 0.39 s (110.99 s total); these sums are neither wall time nor CPU time. Largest dependency units include Tokio 3.68 s (2.97 frontend/0.71 codegen), rustls 3.65 s (2.30/1.35), and syn 3.13 s (2.15/0.98).

Limits: one clean sample per command, three touch-only samples per incremental cell, one Mac, shared host/background activity uncontrolled. A brief web-asset rebuild occurred while the sequential measurement suite was active; no other Rust build/test/load command was launched by this task during the matrix. A separate #153 search-engine measurement (PostgreSQL in Docker) may have run on the same host at the same time, so absolute values can be inflated. Touching is not a semantic implementation/API edit: it does not represent real code changes, can substantially understate real refactor costs, and does not show that a split's effect would be small. No Linux runner/VPS, split prototype, runtime performance, test execution, statistical confidence or split speedup was measured. Raw logs, results.json, runner and Cargo timing HTML remain outside Git under `/private/tmp/codex-378-target`; do not compare these values directly with earlier checker-cost records.

## Search quality comparison (#153, 2026-11-15 JST)

Method fixed before execution: `load/search-engines/quality/{dataset,metrics,modes,run}.ts`. Original authored Japanese business-chat examples plus 2,400 deterministic background Messages; stable UUIDs and explicit gold ids encode intent, never engine output. Each label class has a relevance/irrelevance reason; all unlisted ids are irrelevant. Quality is evaluated against intent even when it intentionally exceeds today's literal semantics. The same query text and gold set apply to all modes, including explicit future query-syntax probes. Thresholds are exploratory fixed choices, not tuned on results or a held-out set.

For each query, full visible/recent result sets give TP, FP and FN; precision=TP/(TP+FP), recall=TP/(TP+FN), F1=2PR/(P+R). Empty gold + empty results scores P/R/F1=1; exactly one empty scores all three 0. Micro sums TP/FP/FN before computing rates; macro averages query P/R/F1 independently (including empty-gold queries), within each class and overall. Classes are not equally weighted in overall macro. Missed-hit and false-positive lists contain complete Message ids per query in external JSON. Ranked modes additionally use binary nDCG@20: DCG=sum(relevant/log2(rank+1)), divided by ideal DCG for min(20, gold count); empty gold scores 1 for empty results, otherwise 0. Ties use ascending Message UUID. Unranked modes have no ranking metric. Metrics and hand-computed unit cases precede the run; no latency is measured.

Reproduce with pinned Node 26.13.0 and Docker: `node load/search-engines/quality/run.ts`; `SEARCH_QUALITY_DIR` selects a fresh external directory (existing destinations refused); `SEARCH_SKIP_BUILD=1` reuses #416's common measurement image. Same migrations, stored NFC → Unicode default casefold → NFC form, Rust-compatible edge trim, escaped literal LIKE, Member visibility, 180-day bounds and non-owning NOSUPERUSER/NOBYPASSRLS app role as #416. One fresh database clone/index per mode; Groonga initialized only after cloning. Same-body controls outside the Organization, in an inaccessible private Channel and outside the date range are irrelevant; ungranted Guest and inactive Member must get no results for every mode/query. Container and anonymous volume cleanup applies on success, failure and SIGINT/SIGTERM. Exact DDL, per-query SQL, settings, source hashes, versions, complete results and scores are saved outside Git. This is an offline retrieval-quality comparison, not an API permission certification or a timing run.

Mode SQL is defined in `quality/modes.ts` and saved verbatim for every query. Literal modes use each #416 index and `normalized_body LIKE <escaped %q%> ESCAPE E'\\'`; pg_bigm `likequery(q)` is a separate equivalent mode. Native GIN modes also use normalized_body: pg_trgm `%` at similarity_threshold 0.1/0.3, `q <% body` at word_similarity_threshold 0.3/0.6, ordered by similarity/word_similarity descending; pg_bigm `=%` at similarity_limit 0.1/0.3, ordered by bigm_similarity descending. These are whole-Message comparisons except word_similarity; no term dictionary or reranker is added. Native PGroonga modes index original body, using `body &@ (q,NULL,'search_body')::pgroonga_full_text_search_condition` or the same with `&@~`, ordered by `pgroonga_score(tableoid,ctid)` descending. Naming the index also selects its normalizer during fallback scans. Three configurations are crossed with both operators: **auto** = NormalizerAuto + TokenBigram; **kana** = `NormalizerNFKC150("unify_kana", true, "unify_kana_case", true)` + TokenBigram; **split** = that kana normalizer + `TokenNgram("unify_alphabet", false, "unify_symbol", false, "unify_digit", false)`. No synonyms, kanji readings or fuzzy-distance expansion are enabled. All modes use full result sets, UUID tie ordering and no display pagination; this does not change the product's newest-first contract.

Recorded conditions: source `6280d222` plus this harness, Apple M5 macOS arm64, Node 26.13.0; reused #416 image `sha256:af98e87cf2b786d5ec4d4aacf342892773de8afe585aff61a8fbf76c4f8f1c77`. PostgreSQL 18.6, pg_trgm 1.6, pg_bigm 1.2 (2025.09.03), PGroonga 4.1.0, Groonga 16.1.3. **2,628 rows**: 57 targeted examples + 2,400 background Messages visible in one public Channel, plus 171 same-body scope/range controls; **33 queries, 14 classes, 72 relevant query–Message pairs**. Frozen clock is 2026-11-15 00:00 UTC. Final artifacts: `/private/tmp/fukulow-search-quality-153-reviewed/`; earlier exploratory/failed attempts excluded. No timings or performance inference from this run.

Overall values are **precision/recall/F1**, rounded to three decimals; nDCG is query macro. The three literal modes and bigm-likequery returned identical ids for every query. These intent scores do not signal literal-substring incompleteness.

| Mode | Micro P/R/F1 | Macro P/R/F1 | nDCG@20 |
|---|---|---|---:|
| trgm-literal | 0.809/0.528/0.639 | 0.814/0.649/0.672 | — |
| bigm-literal | 0.809/0.528/0.639 | 0.814/0.649/0.672 | — |
| pgroonga-literal | 0.809/0.528/0.639 | 0.814/0.649/0.672 | — |
| trgm-sim-0.1 | 0.792/0.528/0.633 | 0.720/0.588/0.587 | 0.624 |
| trgm-sim-0.3 | 1.000/0.028/0.054 | 0.061/0.061/0.061 | 0.061 |
| trgm-word-0.3 | 0.679/0.528/0.594 | 0.715/0.612/0.578 | 0.649 |
| trgm-word-0.6 | 0.892/0.458/0.606 | 0.707/0.530/0.564 | 0.569 |
| bigm-likequery | 0.809/0.528/0.639 | 0.814/0.649/0.672 | — |
| bigm-sim-0.1 | 0.786/0.611/0.688 | 0.788/0.706/0.686 | 0.731 |
| bigm-sim-0.3 | 1.000/0.028/0.054 | 0.061/0.061/0.061 | 0.061 |
| pgroonga-auto-term | 0.846/0.611/0.710 | 0.794/0.710/0.712 | 0.729 |
| pgroonga-auto-query | 0.839/0.722/0.776 | 0.844/0.785/0.773 | 0.801 |
| pgroonga-kana-term | 0.862/0.694/0.769 | 0.794/0.768/0.753 | 0.773 |
| pgroonga-kana-query | 0.853/0.806/0.829 | 0.844/0.843/0.813 | 0.845 |
| pgroonga-split-term | 0.815/0.736/0.774 | 0.779/0.798/0.755 | 0.803 |
| pgroonga-split-query | 0.813/0.847/0.830 | 0.829/0.874/0.815 | 0.876 |

Per-class **micro P/R/F1** for representative modes (literal covers all three engines and likequery; T=trgm-sim-0.1, B=bigm-sim-0.1, A=pgroonga-auto-query, S=pgroonga-split-query). Every mode's per-query values, class micro/macro P/R/F1, class macro nDCG, complete misses/false positives and overall aggregates are in summary.json.

| Class (queries) | Literal | T | B | A | S |
|---|---|---|---|---|---|
| partial (2) | 1.000/0.800/0.889 | 0.000/0.000/0.000 | 0.000/0.000/0.000 | 1.000/0.400/0.571 | 1.000/1.000/1.000 |
| place (1) | 0.500/1.000/0.667 | 1.000/1.000/1.000 | 1.000/1.000/1.000 | 0.500/1.000/0.667 | 0.500/1.000/0.667 |
| notation (5) | 0.600/0.316/0.414 | 1.000/0.368/0.538 | 1.000/0.368/0.538 | 0.667/0.421/0.516 | 0.733/0.579/0.647 |
| smallKana (1) | 1.000/0.500/0.667 | 1.000/0.500/0.667 | 1.000/1.000/1.000 | 1.000/0.500/0.667 | 1.000/1.000/1.000 |
| width (3) | 1.000/0.333/0.500 | 1.000/0.333/0.500 | 1.000/0.333/0.500 | 1.000/0.778/0.875 | 1.000/1.000/1.000 |
| mixed (4) | 0.750/0.667/0.706 | 0.750/0.667/0.706 | 0.667/0.667/0.667 | 1.000/1.000/1.000 | 0.750/1.000/0.857 |
| case (1) | 1.000/1.000/1.000 | 1.000/1.000/1.000 | 1.000/1.000/1.000 | 1.000/0.500/0.667 | 1.000/0.500/0.667 |
| unicode (3) | 1.000/1.000/1.000 | 1.000/1.000/1.000 | 1.000/1.000/1.000 | 1.000/1.000/1.000 | 1.000/1.000/1.000 |
| short (2) | 0.500/1.000/0.667 | 1.000/0.500/0.667 | 1.000/0.500/0.667 | 0.667/1.000/0.800 | 0.500/1.000/0.667 |
| whitespace (2) | 1.000/1.000/1.000 | 0.500/1.000/0.667 | 0.333/1.000/0.500 | 0.333/1.000/0.500 | 0.333/1.000/0.500 |
| literal (3) | 1.000/1.000/1.000 | 0.000/0.000/0.000 | 1.000/1.000/1.000 | 1.000/0.667/0.800 | 1.000/0.667/0.800 |
| typo (1) | 1.000/0.500/0.667 | 1.000/1.000/1.000 | 1.000/1.000/1.000 | 1.000/0.500/0.667 | 1.000/0.500/0.667 |
| syntax (4) | 1.000/0.100/0.182 | 0.538/0.700/0.609 | 0.643/0.900/0.750 | 1.000/1.000/1.000 | 1.000/1.000/1.000 |
| empty (1) | 1.000/1.000/1.000 | 1.000/1.000/1.000 | 1.000/1.000/1.000 | 1.000/1.000/1.000 | 1.000/1.000/1.000 |

Notable misses/false positives (stable keys resolve to UUID/body in dataset.ts and dataset.json): literal `京都` returns **tokyo** (東京都); `AI` returns **aiNegative** (MAIL); `在` returns **stockNegative** (存在). `v2.3` also retrieves **versionNegative** (v2.30); `3月末` retrieves **marchNegative** (13月末) and misses **march2** (３月末). `打ち合わせ` misses **meeting2/3/4** (打合せ/うちあわせ/ウチアワセ); `サーバー` misses **server2/3/4**. `見積` intentionally asks for quantity preparation and retrieves four unrelated quote Messages. Literal NFC/NFD and full casefold cases are perfect, including Straße/STRASSE, but width/kana variants remain distinct. These are intent errors permitted by the current spec.

Native tradeoffs: PGroonga auto fixes width, avoids MAIL/AI and v2.30 in these probes, but misses internal ASCII **BC** in ABC; split tokenization restores those hits and reintroduces MAIL, 13月末 and v2.30 noise. Kana normalization recovers script/small-kana variants, yet cannot infer kanji readings, okurigana equivalence or a removed long vowel: **meeting2**, **estimate2/3**, **server2** remain missed by the corresponding split-query searches. Native PGroonga misses **strasse** for STRASSE, and query syntax consumes the backslash in `c\d`; neither behavior may replace current-spec matching. The query modes satisfy AND/OR/NOT/quoted-phrase intent here but treat the exact-spacing probes as AND and return **backup2/3** for the one-space query. pg_bigm similarity 0.1 recovers the backup typo and large-kana cache spelling, while also confusing API連携/API連結 and collapsing spacing intent. At 0.3 both whole-Message similarity modes recall only 2/72 gold pairs; short-query similarity against an entire Message is length-sensitive. PGroonga scores are nonzero (1 or 2 here) but mostly tied; nDCG reflects deterministic UUID ordering within ties, not a learned relevance model. Literal and native GIN probe plans use sequential body filtering; all six native PGroonga probes use a search_body bitmap scan under RLS. These are small-data EXPLAIN plans without ANALYZE; they establish no latency advantage or current-spec indexed path.

Feature comparison: **R** = exercised in this quality run; **H** = historical #416 evidence; **D** = official-documentation capability or design requirement, **not verified by running here**. “Custom” means work outside that extension, not a built-in feature. The current-spec normalized column is shared by all engines; native PGroonga deliberately indexes original body.

| Feature | pg_trgm | pg_bigm | PGroonga |
|---|---|---|---|
| Normalization / width / kana | R: shared NFC/casefold only. D: NFKC/kana requires our own preprocessing | R: same; similarity itself is case-sensitive, so the shared folded column matters | R: Auto NFKC width; NFKC150 kana + small-kana options. R: no automatic kanji readings/okurigana equivalence; ß casefold differs |
| Tokenization / multi-language | R: alphanumeric trigrams; short substring has weak selectivity (H). D: no linguistic analyzer; Unicode normalization remains ours | R: character bigrams, including Japanese; H: selective two-character lookup. D: no linguistic analyzer | R: TokenBigram and split TokenNgram, Japanese + Latin. D: [TokenMecab](https://groonga.org/docs/reference/tokenizers/token_mecab.html) adds a morphological analyzer/dictionary dependency; other languages need evaluated tokenization |
| Ranking / typo tolerance | R: similarity and word_similarity scores/thresholds, approximate overlap; no guaranteed edit distance | R: bigm_similarity score/threshold, approximate overlap; no guaranteed edit distance | R: pgroonga_score, no typo expansion enabled. D: [pgroonga_condition fuzzy_max_distance_ratio](https://pgroonga.github.io/reference/functions/pgroonga-condition.html) needs separate calibration |
| Synonyms / notation dictionaries | D: custom mappings + SQL/query expansion, no built-in synonym dictionary | D: same | D: [pgroonga_query_expand](https://pgroonga.github.io/reference/functions/pgroonga-query-expand.html) with a maintained synonym table; not automatic semantic equivalence |
| Phrase / AND / OR / NOT | R: LIKE preserves exact spacing/punctuation. D: combine SQL predicates or build a parser; no native query language | R: LIKE/likequery preserve exact text. D: SQL combinations/custom parser | R: &@ single term; &@~ AND/OR/NOT/quoted phrase; query syntax changes literal whitespace/punctuation meaning ([operators](https://pgroonga.github.io/reference/operators/query-v2.html), [syntax](https://groonga.org/docs/reference/grn_expr/query_syntax.html)) |
| Highlight / snippets | D: custom offset/excerpt logic, including mapping folded text back to original | D: same | D: [highlight](https://pgroonga.github.io/reference/functions/pgroonga-highlight-html.html) and [snippet](https://pgroonga.github.io/reference/functions/pgroonga-snippet-html.html) helpers; custom-normalizer highlighting needs source-location tokenizer configuration |
| Schema / extensibility | R: stored normalized_body + gin_trgm_ops. D: extra normalized column/reindex for width; synonym table and query compiler for expansion | R: same with gin_bigm_ops. D: own normalization/expansion schema | R: current form + special tokenizer, or body index with named configuration. D: scoped synonym table for notation; tokenizer/normalizer changes require reindex and regression labels |
| Maintenance / backup | H: bundled extension, GIN/WAL, SQL dump/restore succeeds. D: pending-list/vacuum tuning and target-major binary validation | H: custom source-built extension, GIN/WAL, dump/restore succeeds. D: rebuild compatible binaries for upgrades | H: custom packages + external index files, dump/restore succeeds. D: WAL resource manager, experimental primary crash-safer, workers and upgrade/reindex procedures add operating work |

Primary references for the extension-level comparisons: [pg_trgm functions, operators and index support](https://www.postgresql.org/docs/18/pgtrgm.html), [pg_bigm functions and settings](https://pgbigm.github.io/pg_bigm/pg_bigm_en.html), [PGroonga index configuration](https://pgroonga.github.io/reference/create-index-using-pgroonga.html), [NormalizerNFKC150 options](https://groonga.org/docs/reference/normalizers/normalizer_nfkc150.html), [&@ condition/index selection](https://pgroonga.github.io/reference/operators/match-v2.html), [PGroonga scoring](https://pgroonga.github.io/reference/functions/pgroonga-score.html). Operating references: [GIN maintenance](https://www.postgresql.org/docs/18/gin.html#GIN-FAST-UPDATE), [PGroonga WAL resource manager](https://pgroonga.github.io/reference/modules/pgroonga-wal-resource-manager.html), [primary crash-safer](https://pgroonga.github.io/reference/modules/pgroonga-crash-safer.html), [upgrade procedures](https://pgroonga.github.io/upgrade/). #416 above supplies the historical measurements; this quality run does not repeat backup, write or maintenance testing.

Spec versus future: today's Issue contract is trimmed NFC/default-casefold literal substring, internal whitespace/punctuation literal, visibility/range enforcement and newest-first results. All three literal modes cover that matching rule; bigm-likequery is equivalent. It does **not** support width/kana folding, readings/synonyms, typo expansion, token-boundary exclusions, relevance ordering or boolean/phrase query syntax. None is silently adopted here. Likely later needs are width-insensitive matching (PGroonga auto, or custom preprocessing for either GIN engine), kana/small-kana variants (PGroonga kana/split), spelling/kanji/okurigana variants (curated expansion for any engine; PGroonga provides a native helper), typo suggestions (GIN similarity or separately evaluated PGroonga fuzzy search), advanced expressions (PGroonga query or a custom SQL compiler), and relevance/snippets (PGroonga scores/helpers or custom GIN scoring/excerpts). Avoiding 京都/東京都 noise while retaining intended internal substrings requires a separate intent/word-boundary policy; no tested mode solves both universally.

Limits: one small synthetic vocabulary, author-defined binary relevance and one intent per query; no human relevance study, held-out threshold tuning or graded ranking labels. Most background rows are easy negatives; the targeted 57 examples carry the difficult distinctions. Repeated queries within classes weight overall results. Query-syntax probes intentionally exceed literal semantics, so cross-mode aggregate F1 is not a drop-in compatibility test. All target Messages are short and in one visible Channel; no production distribution, Topics/Reply-chain diversity, DMs (absent from this schema), concurrency, pagination, revocation matrix or API behavior is certified. No Linux performance measurement, index access-path guarantee, maintenance, crash or replication drill or performance claim is made. Source hashes and exact SQL/settings in external artifacts bound reproducibility; label changes require a fresh run.

Proposal for the maintainer: **pg_bigm GIN remains the proposed engine for the current-spec implementation**, with two-character queries retained subject to the unresolved RLS-safe/Linux performance gate. Quality is identical across current-spec engines; PGroonga's strongest native mode improves intent recall to 0.847 versus literal 0.528, but changes normalization, punctuation, token boundaries and ordering, and still misses notation variants. #416's Mac evidence favors pg_bigm's selective two-character owner lookup and smaller index/lower write overhead over PGroonga; its app/RLS path did not demonstrate search-index use, so those advantages are not a production speed claim. PGroonga is the stronger built-in future-feature candidate if the maintainer prioritizes width/kana/query syntax enough to accept its operational cost and the measured tradeoffs. This is a **proposal for the maintainer**, not a formal engine decision or implementation-gate pass: **Linux performance is still unverified**, and **changing current-spec semantics is a separate decision**.

## Search evaluation freeze and lifecycle procedure (#153, 2026-11-15 JST)

Follow-ups to the preliminary #416/#420 records: `load/search-engines/manifest-v1.json` freezes the next evaluation before execution. Its SHA-256 covers the versioned payload: generator version/seed and frozen clock; source hashes for the generators, harness, modes, metrics, migrations and role/grant SQL; corpus/query/relevance hashes, explicit query texts and relevant fixture keys with class policies; 2,457 visible quality Messages / 2,628 total rows, 33 queries, 14 classes and 72 relevant pairs; the 1,000,000-Message performance dataset, 28 queries, engine order, concurrency, repetitions, warm-ups and transaction counts; pinned base-image digest and PostgreSQL/extension package versions; PostgreSQL settings, shared memory, range and lifecycle deadlines. Source/query/label/condition changes require a reviewed new manifest version before another run; neither runner rewrites the manifest. Existing size/transaction overrides that differ from the freeze are refused. Node must match the frozen version. After startup, actual PostgreSQL, available extension versions, packages and selected settings must match before data loading or scoring/timing. `SEARCH_SKIP_BUILD=1` still performs these checks. Results and summaries record the manifest hash; the exact manifest is copied beside artifacts.

Both entrypoints now run their synchronous SQL work under a signal-responsive supervisor. It owns a unique container and explicitly named data volume before creation is attempted, kills the worker/client process group on SIGINT/SIGTERM, and removes and verifies both resources after success, exceptions or deadlines. Docker calls are bounded at 120 seconds, builds/psql/pgbench at 900 seconds, and each cleanup/removal/verification call at 10 seconds. A psql deadline escapes startup retries immediately. Command failures omit raw command input/output. `run-status.json` records whether cleanup was verified and whether the run is valid; a failed cleanup or verification cannot produce a valid run. Retained external results are artifacts, not temporary scratch directories; SQL and pgbench scratch files inside the container disappear with its data volume. The reusable measurement image/build cache remain.

No evaluation was run for this change; verification uses small local fake-process tests, including interrupted hung clients, manifest/runtime mismatches and failed cleanup verification. The freeze does not retroactively validate old results, provide bit-identical rebuilds of unpinned transitive build packages, control host/VM load or certify Linux performance. An unavailable Docker daemon, SIGKILL of the supervisor or host failure can prevent physical removal; failed or unverifiable cleanup is reported, never treated as valid. The current-spec semantics and every quality/performance threshold remain unchanged; pg_bigm and PGroonga adoption remain on hold.
