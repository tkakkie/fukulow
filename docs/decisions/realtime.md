# Decisions: realtime

Real-time delivery, admission, queues and timeouts. Writing rules and the other parts: [index](../decisions.md).

## Real-time delivery
- #195: SIGTERM/SIGINT stop acceptance and reject new requests, broadcast 1001, then drain HTTP, detached sends/notifications and sockets before closing the pool. Count before spawn/upgrade so caller disconnects and task handoffs cannot hide work.
- #195: retain provisional 60 s drain / 75 s Compose stop_grace_period from measured drains: 2,048-send SIGTERM <=814 ms; idle 10k restart <1 s (measurements.md). These are not guaranteed worst-case times; pre-admission SQL can exceed them. Expiry skips runtime teardown.
- #195 known limit: on normal exit, Tokio runtime teardown is outside the drain and can run past its 60 s deadline. Retain the current teardown behavior; no larger change now.
- #195: sockets independently observe one shutdown watch and send Close concurrently, each capped at 1 s; a slow peer cannot serialize 10,000 closes. Upgrade callbacks retain a drain guard before handoff so late scheduling cannot race pool close.
- #195: SIGKILL, crashes and drain expiry cannot promise COMMIT outcome or Close delivery. Retry the same client_message_id and resubscribe from the gap-free cursor; #135 resolves uncertain COMMITs without duplicate Messages.
- Subscribe handoff: register live first, replay committed seq > cursor in 50-Message pages, flush newer queued events, then send `subscribed`. Clients dedupe by (channel_id, seq): duplicates allowed, no gaps (#18).
- Full queues close with 4008, never silent loss; clients reconnect from each Channel's last seq. Per connection: 256 queued events, at most 256 subscriptions (#18).
- Messages owns post-commit fan-out; Channels owns visibility. Fan-out checks all candidate Members in one visibility query (no per-recipient SQL) and shares canonical payloads; authorization-query failure closes with 4008 for replay (#18).
- Message persistence and sign-out finish regardless of HTTP cancellation, so a commit cannot skip notification (#18).
- Future subscription cursors are clamped to the committed high-water seq so clients resume live delivery after a database restore (#18).
- One shared FIFO queue per connection: an accepted subscribe sends `subscribed` only after every event queued before it, across Channels (used by contract silence barriers). Not a cross-Channel order guarantee; preserve or replace with its proof (#116).
- #57 PR B: notification runs detached after COMMIT; HTTP awaits persistence only. A guard armed before COMMIT makes an incomplete task signal that Organization/Channel's sockets to close with 1011, so reconnect replays (no durable queue).
- #179: notifications reserve at most 40 tasks per Organization/Channel and 2,048 per Delivery before spawning. Publication takes one of 40 global execution permits only after the cursor lock; saturation latches 1011. HTTP never waits on notification capacity.
- #179 chooses separate bounded cursor-wait reservations over coalescing to preserve hot-Channel admission and recovery behavior. The 2,048-task ceiling bounds retained work across Channels; the 10 s deadline still includes cursor waiting, and Drop frees reservations on every exit.
- #190 chooses 512 reservations/Organization over 256: both preserve B in the controlled probe; 512 gives twice the temporary many-Channel headroom while leaving 1,536/2,048 slots beyond any one Organization. A conservative bound, not an optimum.
- #190 counts reservations under one short mutex for acquisition and final removal, avoiding stale-entry races. Each guard retains its global permit until after removal, bounding Organization entries to 2,048; no async wait or publication lock is added.
- Authorization reads `channels.visibility` fresh on each REST/replay check and fan-out; nothing is cached or carried from HTTP into fan-out, so a committed visibility change is seen next. Public costs one boundary query (#57 PR B).
- #135 ambiguous-COMMIT recovery: persistence takes a scoped transaction advisory lock exclusively before COMMIT; watermark reads take it shared, then read in a separate READ COMMITTED statement, so replay recovers every committed Message without a later send.
- #135: outcome lookups cannot prove rollback from absence, so they are not used. Each watermark is bounded to 10 s including pool acquisition; an unresolved outcome closes that socket with 1011. Cost: one extra statement per send.
- #135 suppresses 1011 only for COMMIT errors known to roll back: SQLSTATE class 23 and 40000/40001/40002/40P01. I/O, shutdown, 40003 and timeouts (incl. 25P04) stay conservative.
- #147 watermark: a materialized `set_config('lock_timeout', ...)` CTE precedes the shared lock in one statement (5 -> 4 round trips); the counter SELECT stays separate to keep #135's fresh snapshot.
- #57 item 4: fan-out snapshots recipients under a per-Channel mutex; the global registry only hands out counted Channel leases. One publication cursor per Channel recovers missing committed Messages once in 50-Message pages and reauthorizes each page.
- #57 item 4 evidence: under a forced reorder with 128 sockets, SQL fell from 779 to 12 statements (no per-socket refills). Item 6 (fixed offered-load comparison and queue caps) is #178.
- #57 item 4: `auth` owns the active-Member predicate; `channels` owns one public/private grant predicate and query builder. Reads, subscribe, replay and fan-out are non-locking; batched candidates are bounded by `id = ANY($3)`.
- #173: shared recovery covers at most one 50-Message page (also bounded by the 256 queue). A larger gap latches Channel failure (1011) and advances the cursor; replay itself stays paginated without this limit.
- #173 safety: subscribers before the latch keep their failed epoch and reconnect from their cursor; later ones register live before the barrier-protected watermark. Cursors discard overlap: ascending at-least-once, no omissions while authorized.
- #173: each recovery page re-queries visibility. Authorization-query failure sets overflow (4008) for that snapshot and advances; a page-read failure latches 1011 and keeps the cursor. Both fail closed and recover through replay.
- #136 notification failure uses one watch per latched Organization/Channel epoch: the HTTP failure path is one lookup, swap and at most one spawn, with no recipients lock, subscriber iteration or inline wake-up.
- #136 evidence: idle CPU at 10,000 sockets fell from ~58% to ~3% of one core. 1011 bulk-close median rose (~120 -> ~157 ms), a same-runtime scheduling artifact of waking 10,000 tasks at once, not a shown production regression.
- #136: each socket owns one failure-monitor task (abort-on-drop) and awaits its oneshot in a `biased` select, keeping 4001/4003, then 4008, then 1011 priority. Outside a Tokio runtime `Signal::fail` keeps the latch and skips the wake.
- Ping every 30 s; the first Ping after the last client frame starts one 60 s grace, so an idle unanswering socket closes with 1001 after ~90 s. Reason: keeps idle sockets exercised without frequent traffic at 10k sockets (#57 item 5).
- Heartbeat uses the existing loop's single interval (no task, no env setting). All frame writes share the 5 s send deadline (4008 on timeout, 1001 on write error). Client Close is answered within 1 s (#57 item 5).
- #148 separates two responsibilities: (1) gapless `seq` allocation (the counter row update, order within a Channel); (2) the #135 commit/watermark barrier (readers may trust every `seq` <= W is committed). Neither provides the other.
- #148 fixtures for behaviour not implemented yet are marked `proposed` with an owner Issue: validated, skipped and listed by runners; planned vocabulary fails validation elsewhere. Membership-check fixtures are controller-layer: the pure protocol has no I/O.
- #307 invalidate and refetch (maintainer, 2026-11-14): notices carry ids and log positions only, never a Message body or count; clients refetch REST baselines. Reason: REST stays the one Unread/list authority, so notices cannot drift from it, and #152 Mention counts need no new event.
- #307 notices go automatically to every socket after registration, announced by `activity_ready`; no subscribe frame. Reason: one per socket under the #196 A caps, no control-frame cost or failure state, and the ready frame gives a testable baseline handoff without the 256-subscription cap.
- #307 event-specific recipients require a live Session and current active Membership. Ordinary Channel events require access; revocation reaches only its former-access target. Directory notices use #294 visibility. Reason: loss must be reported without telling never-authorized sockets.
- #307 own-access changes invalidate a Guest's directory, including removal, even before #294. Pre-invalidation directory responses lose authority. Reason: the last shared Channel can disappear without another Member mutation.
- #307 notices coalesce in a separate 256-key buffer; overflow resets only with valid authorization provenance, else uses spec O5 recovery. Reason: bursts must not broaden recipients or cause reconnect storms.
- #307 O5 adopts periodic REST reconciliation of held targets (provisional 30 s, first run spread over the period); mutation-triggered failure resets require proven recipients. Reason: repeats cover loss/delayed COMMITs; empty resets disclose timing. No persistence/per-mutation outcome fences now.
- #307 unknown COMMIT is not rollback, and a fetch before outcome resolution cannot finish recovery. Reason: Channel-list snapshots lack #135's barrier; a delayed COMMIT can follow a successful fetch without another mutation.
- #307 publication epochs fence queries, enqueue and first handoff; observed loss retires the epoch and re-grant creates another. Reason: buffer purging or current access alone cannot reject a paused old publisher.
- #307 batches freeze seq before authorization and preserve each recipient's other-sender activity. Reason: later commits need a fresh snapshot; a sender's own Message must not supersede someone else's invalidation.
- #307 target coverage is independent: a Topic position never proves aggregate freshness. Dirty REST targets retry transient failures with capped backoff and fenced timers. Reason: delayed read notices and failed fetches must converge without another mutation.
- #307 clients coalesce refetches (one in flight, one queued, short debounce, jittered reset). Reason: bursts cost one request per target per round trip; retries retain dirty state and cannot bypass backoff.
- #307 only post-access-invalidation lists add Channels; reappearance starts a client access generation; P8 selection stays within it. Directory invalidations fence old responses. Reason: stale snapshots must not restore lost access or visible Members; no exposed grant id is needed.
- #307 `channel_access_revoked` is Organization-scoped and separate from subscription-scoped `channel_access_lost`. Reason: keeps C9/S4 semantics unchanged while unwatched Channels lose their badge at once.
- #151 dm_list_changed targets only the affected Member's live/current-revision own sessions with DM access. DM activity/read changes reuse channel_activity/read_position_changed. Reason: empty/new DMs need discovery, and /dms is a separate REST target (B4).
- #151 DM discovery reuses A5-A8's bounded buffer/provenance and A9-A14/O5's single reconciliation schedule; no DM poller. Reason: inactive badges, lost notices and delayed COMMITs converge without sending failure traffic to unproven recipients.
- #151 DM list responses follow independent invalidation/access generations; renewal replaces only lapsed lifetimes, and unwatched recovery replaces baselines. Reason: stale responses/publishers must not revive old access or Unread, including after reactivation.
- #151 DM list base limits: 50-row pages, 200 retained rows, five total attempts/O5 run incl. retries/continuations; two discovery slots, three fairly shared by held-id refresh/browsing/recovery (2026-11-14). Reason: bound work without starving any lane; preserve independent keys.
- #151 B4 adopts Option A durable discovery, rejects Option B (2026-11-14). Reason: no still-accessible DM may be missed after lost notices/delayed COMMITs; first-page or descending mutable-key recovery cannot guarantee it. Protocol: spec/dms.md P-D1-P-D7.
- #151 coalesces discovery by Organization/Member/revision/DM; independent rolling delta and frozen-birth coverage each get one O5 slot (2026-11-14). Reason: with no changes, ≤500 pending after saved delta cursor drain in ≤10 runs/≤332 s regardless of coverage; fixed keys prevent hot-row starvation.

## Personal section notices (#204, specified)

- #204 sections_changed goes only to the changed Member's current sessions in that Organization, including the caller and sockets with no subscriptions. It carries no section data. Reason: devices converge without disclosing personal grouping.
- #204 section notices share #307's post-COMMIT publication, buffer, proven-recipient resets and O5 periodic REST reconciliation of held targets. Reason: recovery must converge without another mutation or disclosing personal activity to other Members.
- #204 section display intersects authorized layout and Channel-list snapshots under A11/A12 fences; loss hides immediately. Reason: a stale personal-layout response must never restore a Channel hidden by access loss.

## Admission and timeouts
- #196 B app pool: FUKULOW_DB_MAX_CONNECTIONS defaults to 20 (3..=u32::MAX); FUKULOW_DB_ACQUIRE_TIMEOUT_MS defaults to 1000 (1..=5000). Reject invalid startup values. Minimum 3 gives each admission budget a slot; the acquire cap fits the 5 s session-check deadline.
- #196 B keeps #156/#158's min(16, P-ceil(P/5)) budget: send ceil(B/2), watermark floor(B/2). P=3 gives 1+1 and 1 spare; P=20 gives 8+8 and 4 spare; above 20 budgets stay 8+8. Reject P=1/2: no watermark slot. Raising P does not raise admitted concurrency.
- #196 B headroom is shared by session checks, auth, history and other reads, not reserved for sessions. Unadmitted query floods can still starve checks: their 5 s deadline closes 1011, never 4001/4003. No per-Organization fairness claim; #190/#199 remain separate limits.
- #196 B sets session-level statement_timeout=10s on every new app connection, bounding ordinary queries and lock waits. #158 barrier transaction_timeout=8s stays below statement/lock timeouts (10s) and the app work deadline (10s); #135's fresh-snapshot barrier is unchanged.
- #196 B leaves RLS Account/Organization settings transaction-local; the session statement timeout survives COMMIT/ROLLBACK. Cleanup keeps its tighter local 1 s timeout. A statement/COMMIT timeout remains an unknown outcome under #135, not proof of rollback.
- #196 B migrations disable statement_timeout and transaction_timeout on their discarded connection, retaining lock_timeout=5s. DDL may outlast ordinary queries; success, failure and cancellation must never return these migration-only settings to the app pool.
- #88/#194 B bounds one-shot migration lock waits with session-local `lock_timeout = 5s`, including SQLx's advisory lock. Reason: queued exclusive DDL can stall later reads/writes; fail before listening instead of waiting. No automatic retry.
- Connection budget `min(16, pool_max - ceil(pool_max / 5))` keeps at least 20% of the pool outside sends and watermarks. A trial cap of five rejected startup subscriptions; 16 passes the burst (#147).
- The budget is partitioned (#156, #158): sends round up, watermarks round down (8 each in production), no borrowing; per Organization/Channel at most one send and four watermarks. No per-Organization DB admission reservation.
- #156 chose bounded admission outside the pool over short-wait or try advisory locks: a DB lock wait still holds a connection, and try-lock turns normal contention into repeated 1011/reconnect and send failures.
- Watermark admission waits at most 1 s; send admission 30 s (a queued send holds no connection), then 10 s persistence work, so a send response is bounded by 40 s. Session and Channel authorization still come first (#156).
- The exclusive barrier precedes counter allocation with transaction-local `lock_timeout=10s` and `transaction_timeout=8s`, so PostgreSQL ends stuck work before the app's 10 s deadline; prevents leftover COMMIT backends/locks (#158).
- #158: the owned transaction holds Channel and budget permits through COMMIT/ROLLBACK with explicit BEGIN/COMMIT; on error, cancel or deadline its Drop detaches and drops the connection instead of awaiting close behind a stuck COMMIT.
- Exactly one Delivery per application pool (shared by its clones) sizes the budget once; only Delivery exposes watermark access outside `messages`. A stuck Channel holds at most four watermark and one send connection (#156).
- `transaction_timeout` starts only at the barrier: pool acquisition and the initial canonical lookup come first, so up to 8 s of server work can outlive app abandonment; not an absolute HTTP bound. No prepared transactions (#158).
- Socket abandonment does not prove rollback (PostgreSQL may still COMMIT), so #135's shared barrier, current authorization and canonical same-key retry stay necessary (#158).
- #161 caps queued send waiters at 256 per Organization/Channel and 2,048 globally, reserved before spawning. #178 kept these values; one Organization can still consume all global slots.
- #161: queue-cap rejection and 30 s admission expiry return 503 `ErrorBody` with a random 1-5 s Retry-After (shared saturation, so not 429). DB failures, unknown COMMIT and the 10 s work deadline stay 500/unknown outcome.
- A dropped connection or response timeout is not evidence of non-persistence (detached work may run 30 s + 10 s): clients retry with the same client_message_id, never a new key (#158, #161).
- #198 B: admission sites only increment fixed categories; report nonzero cumulative counts every 60 s to bound rejection diagnostics. WebSocket gauges count established callbacks through Drop; closes count server attempts by fixed code, not confirmed peer receipt. No entity labels.
- Admission is a bounded-wait guard, not a dedicated HTTP pool: auth, history, replay and notification share the same pool (#156).
- Known limits for the 10k target: FIFO budgets can delay unrelated Organizations; four watermarks per Channel cap popular-Channel reconnects (~1,000/s at ~4 ms each); 10,000 simultaneous reconnects need client backoff (#156).
- #178 keeps send queue caps 256/2,048: smaller caps raised refusals; larger ones roughly doubled accepted HTTP/delivery delay with no shown capacity benefit; RSS did not discriminate. A conservative choice, not an optimality or fairness claim.
- #179 isolates held cursor waiters from execution capacity. #190 prevents only one Organization monopolizing reservations; simultaneous multi-Organization exhaustion and contention for the 40 shared execution permits remain. No cross-Organization fairness guarantee.
- [#199](https://github.com/tkakkie/fukulow/issues/199): measured, the cap stays 4; cap 2 cut steady-state throughput ~31% and raised recovery 1011 admission rejections ~45%, with no significant 10,000-client recovery-time improvement. The cap-2 change is not merged.
- #199 known limit: two stuck Channels can hold all 8 watermark slots; another Organization's subscribe then fails with 1011. #213 defers per-Organization watermark fairness unless cross-tenant failure spread becomes a real problem.
- #212 follows up handshake admission, listen backlog and accept pacing; client jitter is in #195. #199's local recovery was bounded by handshake capacity, not the watermark cap; it does not establish production 10,000-connection capacity.
- #196 A caps: 32 open sockets per Account (all Organizations and Account Sessions) and 12,000 globally (10,000 target + 20%). Account cap and budget are checked first under one lock, so a refused Account holds no global slot. 503 socket_limit with a random 1-5 s Retry-After, as #161.
- #196 A budget: every client text/binary frame is charged before DB access to the connection (burst 300, 4/s) and its Account (burst 600, 8/s, kept across reconnects). Bursts fit a 256-Channel bootstrap (two per Account). Over budget closes with new code 4029; clients back off as after 1011.
- #196 A: an Account with an empty budget is refused at upgrade (503), not after it: measured, reconnecting after 4029 otherwise cost ~660 upgrades/s each with a session check. Refused upgrades still cost one authentication query; handshake admission is #212.
- #196 A: a duplicate subscribe is a charged no-op whatever its after_seq (maintainer, 2026-11-13): the client already holds that cursor; replay again via unsubscribe+subscribe (charged twice) or REST. It closed the re-subscribe bypass of the 256-subscription and query costs.
- #196 A: the Account table holds up to 100,000 budgets. At the bound, idle full entries are dropped, then the idle entry closest to full is evicted (its Account restarts full), so depleted Accounts cannot block new ones; active entries are at most the global cap.
- #196 A read buffer 8 KiB (tungstenite default 128 KiB): measured ~120 KiB less RSS per idle socket (~1.15 GiB at 10,000); 4 KiB saved only ~4 KiB more per socket, so 8 KiB keeps a 16 KiB message to two reads. Idle CPU did not differ.

## Entries in other parts

Entries that also govern this area, listed by the start of the entry in that part.

- [process](process.md): `#198 B: pinned tracing/subscriber`, `#198 B: a domain-independent observability`

- [load](load.md): `#151 adopts DM performance acceptance`
- [messages](messages.md): `#151 DM is a Channel kind`, `#151 new sends hold`
- [auth](auth.md): `#151 DM access needs`, `#151 explicit non-Guest open`, `#151 peer eligibility belongs`
- [messages](messages.md): `#204 sections belong`, `#204 access loss hides`, `#204 composite Organization/Member/section`, `#204 moves, reorders and deletes`

- [auth](auth.md): `#305 owns the deactivation transaction`

- [auth](auth.md): `#314 single-statement hot reads use`

- [auth](auth.md): `#149 channel_access_lost carries only channel_id, keeps`, `#149 observed loss fences queued/replay frames`, `Two independent revocations: ending an Account`, `Revocation boundary: history/replay deny once revocation`, `Classification precedence: known Account Session end`
- [auth](auth.md): `Open sockets use the database expiry`, `The initial WebSocket session check is`, `#157 supervises the worker: any unexpected`, `#163/#195: successful return after registry drop`
- [messages](messages.md): `#149 grant_id is a durable UUID`, `#149 fast subscription rechecks/failures target Organization+Channel`, `#149 subscriptions follow the current access`, `#149 API mutations lock Organization, Channels`

- [messages](messages.md): `#311 Target Member NO KEY UPDATE precedes`, `#311 Right-only updates skip Unread triggers`

- [auth](auth.md): `#304 recheck current Session/password under locks`, `#304 wrong current password is 403`
