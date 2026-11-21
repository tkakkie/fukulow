# Issue #689 search SQL PoC

Run from the repository root with Node from `.node-version` and the local `fk689-poc-pg:local` image built from `load/search-engines/Dockerfile` (PostgreSQL 18.6, PGroonga 4.1.0). The output directory must be new and outside the worktree, with an existing parent. The runner owns and removes the container it creates.

```sh
node --test load/sql-probes/689-d3/*.test.ts
npm --prefix load run check
node load/sql-probes/689-d3/run.ts --smoke --repetitions 4 --out /private/tmp/fk689r-smoke-N
```

Smoke uses one client and produces no measurement evidence. An approved recorded run uses five clients on an idle host, with `--repetitions` read transactions per client, class and arm (default 20 without `--smoke`). Each recorded write arm uses one writer and 200 transactions per operation. Follow [focused SQL measurement retention](../../../docs/workflow.md#14-focused-sql-measurements) for recorded artifacts.

## Query shapes and fixture

- **d3** uses PGroonga exact equality over `<Channel UUID>:<gram>` keys with tokenization and normalization disabled. It rechecks all candidates from visible scopes and sorts the hits. All term shapes use distinct one-, two- and three-scalar grams of the normalized Message body. Short queries use the full normalized text as a key, and longer queries use the first trigram and recheck the full escaped LIKE.
- **d3r** uses a B-tree keyed by Organization, Channel, gram, then `created_at DESC, message_id DESC`. The equality prefix selects an ordered recency range that PGroonga cannot supply. The per-scope LATERAL walks that range and probes the current Message by primary key. It checks the Channel, timestamp, B1 date window and escaped LIKE before taking 20 hits. The outer query merges by the same timestamp and Message ID order. The timestamp is duplicated in the term rows to support the ordered walk.
- **d4** walks the existing Message recency B-tree per visible Channel, taking 20 hits after escaped LIKE. Its timed transaction disables bitmap scans locally. The plan report includes the unforced setting.

All three use the B1 visibility CTE in a transaction with forced tenant RLS and a non-owning role without BYPASSRLS. Send, Edit, Delete and Move maintain each strategy's terms in the Message transaction. Grant removal, Guest Role changes, deactivation and Channel visibility changes take effect through the visibility CTE and leave both term sets intact. The consistency suite also plants stale public-scope keys pointing to a private Message.

The 16 existing queries use the original 24,007-Message fixture. The two extra queries use a fresh copy with the same row count. It has 32 matches at one timestamp across three scopes, and one scope with 26 recent candidates that fail LIKE ahead of 25 hits. The fixture uses repetitive bodies and physical Deletes. The owner oracle applies independent visibility and literal substring checks.

## Gates and outputs

- `gates.json` records the runner's PASS or FAIL for correctness, early stop, RLS and timing exposure. `correctness.json` includes the full and ordered top-20 oracle results and variant mismatches. `consistency.json` records the 18 search checks and accompanying term mutations and authorization snapshots.
- The frequent d3r plan must use the ordered term index. The runner captures the combined plan and the same query restricted to each visible scope to get exact per-scope counts instead of EXPLAIN's loop averages. Each scope may return at most 20 term rows plus failed rechecks, the merge may consume at most 100 rows, and no executor node may consume as many rows as there are visible matches. Raw plans and scan summaries describe executor work.
- RLS verification checks role flags, ownership, forced and active RLS, the exact policy set and zero rows without Organization context. It also checks denial of foreign-Organization rows and context cleanup after commit.
- `timing.json` compares fresh 1-vs-1,000 foreign-match arms for another Organization, a private Channel and a DM. The arms have the same visible page, row fingerprint, body lengths and term counts. Warm-ups and alternating sample blocks are paired. A plan difference fails the gate. A class and variant are flagged as **possible leak** if the many/few p50 and p95 ratios are both at least 1.10 or both at most 0.91.
- `latency.json` reports p50/p95 and raw samples. `plans.json` summarizes raw EXPLAIN plans. `stability.json` compares the frequent query from parameterized custom and generic plans across three fresh databases, including forced and unforced d4. `metadata.json` captures provenance, settings, roles and sampling conditions.
- `writes.json` reports d3 and d3r separately. Each matched database keeps only its measured strategy's term table, maintenance triggers and indexes alongside the Message primary key. It reports commit-inclusive send, Edit and Delete latency, PostgreSQL WAL insert-LSN deltas and logical tuple bytes. Storage reports each strategy's heap and index bytes, including d3's incremental Groonga files, and a linear 1M-Message extrapolation. PGroonga WAL and crash-safe mode are off in the pinned image. The extrapolation measures neither churn nor 1M-Message performance.

The term tables have tenant RLS. Channel authorization depends on reading them through the query-time visibility CTE and rechecking the Message. Direct term lookups, counts or estimates can expose grams from private Channels and DMs. Production writes would require owner or trigger code with no direct term-table grant to the application role.
