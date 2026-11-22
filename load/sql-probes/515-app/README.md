# #515 REST replay app-path diagnostic

Measures public Channel gap-fill at the night 3 Part C revisions, A `4542f5453ac66103a643be821728b1d7f4118558` and B `b975ffa0de92a256ffeb82f63af798e4c41f00f4`. This diagnostic gives no PASS/FAIL. Night 3 remains 3 FAIL and 1 INVALID, with the same thresholds.

## Run

Use the repository Node version, Docker Compose and an idle host. Use a new absolute output path outside the checkout with an existing parent. Run recorded mode only on the maintainer's go. The runner builds each revision's release Dockerfile twice from its Git archive. It verifies the downloaded SQLx source against the revision's lock checksum before applying the driver patch. Image labels and metadata include the full revision, arm patch SHA-256 and driver patch SHA-256. Unpatched controls carry `none` for both patch hashes.

```sh
node --test load/sql-probes/515-app/results.test.ts
npm --prefix load run check
npm --prefix load run check -- -p sql-probes/515-app
node load/sql-probes/515-app/run.ts --smoke --out /private/tmp/fk515a-smoke
node load/sql-probes/515-app/run.ts --rehearsal --out /private/tmp/fk515a-rehearsal
node load/sql-probes/515-app/run.ts --recorded --out /private/tmp/fk515a-recorded
```

- Smoke uses 20,000 and 10,000 Messages, 20 timed requests per arm, variant and cell across two blocks, and two warmups per block. It validates the harness. Rehearsal uses the full fixture and the 1M-recent cell with one B/A block of 50 requests for each variant. Both modes are never evidence.
- Recorded mode uses 1M and 100k Messages across recent and deep cells, 500 requests per block, two blocks per arm, variant and cell, and ten discarded warmups per block. Arm order is B/A then A/B. The patched pair goes first in the first block and the control pair goes first in the second.
- The [SQL probe](../515-replay/README.md) supplies all fixture builders, database settings, migration verification, settle steps and cursor positions. Each of the four disposable Compose projects has one Organization, 4,000 Members and 200 public Channels with the same 17-byte Message bodies. The reader's existing synthetic Session slot receives a bearer-token hash so HTTP can authenticate as Member 0. The runner verifies fixture checksums match. The server uses its regular runtime role and RLS over the Compose network. Cleanup removes the run's own `fk515a-` Compose projects and volumes. The labelled images stay in the local cache.

## Read the output

- `metadata.json` records the settings, fixture, role/RLS check, revisions, image IDs and repeat order. `A-statements.json` and `B-statements.json` record extracted SQL and source references. `status.json` tracks setup and completed blocks. Each block has a host snapshot and HTTP samples. Patched blocks also keep per-request interval logs and parsed components. Warmups stay in raw files.
- Both app patches scope timers to the relevant GET with `after_seq` and a sample ID. A times its scoped visibility, watermark transaction, event page and hydration. B times its history snapshot and row-by-row Message decoding. Both include auth, response body construction and serialization, and the handler and request totals. SQL elapsed time is measured around SQLx execution, including network and possible prepare or protocol-drain work. Observed row conversion is subtracted from that interval where it occurs inline. The patches preserve SQL text, order, transactions and response construction.
- The shared SQLx patch times the existing pool permit wait, connection open and checkout/return pings. The normal return task holds the trace until it finishes, allowing one JSON line even when the return ping outlives the HTTP response. App server, database and client timers keep their original boundaries. The client measures on the host through the end of the response body and parses the page afterward.
- `summary.md` compares each component's p50/p95 and the A − B difference. The synchronous trip group combines checkout checks with the non-page replay SQL difference. The extra async return checks are measured as elapsed ping time, with overlap reported separately. Their causal contribution to HTTP latency is not identified. The summary compares the per-request component sum with the observed HTTP gap at the HTTP percentile ranks and reports the unexplained remainder. The unpatched HTTP gap and the shift with instrumentation show how much the instrumented results differ under matched schedules on independent stacks.
