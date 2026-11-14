# Decisions: messages

Channels, Messages, Topics, Replies and Unread. Writing rules and the other parts: [index](../decisions.md).

## Channels and Messages
- #149 usable managers (Owner/Admin with access or usable Channel manager right, #311) add/remove; every Role may leave its own grant. Private removal preserves the last usable grant and, if present, manager (409); serialize checks/removal per Channel to prevent races.
- #231/#305 reject Role demotion or deactivation with 409 last_channel_manager if a private Channel loses its last usable manager; atomic, no Channel details. Reuse #149 locks/check via auth's injected guard for module direction. Unmanaged Channels stay allowed.
- #292/#311: a private Channel's creator gets a Channel manager right on their grant, independent of Role; usable manager = usable grant with Owner/Admin Role or the right. Reason: a Member's private Channel must be able to add people without giving Owner/Admin implicit access.
- #292/#311 The right lives and dies with its grant: removal, leave or a change to Guest ends it; renewal, re-grant and reactivation never restore it. Reason: no right outlives the access it came with (#146, #149).
- #292/#311 last_channel_manager counts both kinds of usable manager for revoke, remove, leave and Role changes (#149/#231); #305/#237 reuse it for deactivation; authorize, SQL rechecks and Capabilities share one rule. Reason: one count keeps a managed Channel managed.
- #292/#311 Guests cannot hold the right. Reason: Guests get least privilege and never add Members (#294).
- #311 PATCH /api/v1/orgs/{org}/channels/{id}/members/{member_id} {manager:bool} and can_manage_managers control the right. No-op requests reauthorize and validate targets, preventing stale UI state from granting authority.
- #311 Manager PATCH uses 400 channel_manager_private_only/channel_manager_guest, 404 member_not_found/channel_grant_not_found, 409 last_channel_manager. Inaccessible Channels keep 404 channel not found, preventing existence leaks.
- #311 Target Member NO KEY UPDATE precedes grant changes, including Guest right clearing before the Role UPDATE. Reason: a new send must not take Member SHARE and wait on a grant while Role change waits back on that Member.
- #311 The private-Channel trigger locks its Channel row through COMMIT, so a manager flag and a public visibility transition cannot both commit, including direct SQL; a plain cross-table check would race.
- #311 Right-only updates skip Unread triggers; the right changes no access, grant_id or subscription. Guest changes clear rights before Role reconciliation, preserving grant -> Unread lock order across Channels.
- #292 No backfill for existing private Channels: no creator was recorded, guessing could grant a right nobody chose, and nothing is deployed yet. Channels without a usable manager stay allowed as before (#149).
- #149 grant_id is a durable UUID per grant lifetime; re-grant/renewal cannot revive an old subscription after a lost fast signal. Public non-Guests keep continuous access when a redundant grant is removed.
- #149 fast subscription rechecks/failures target Organization+Channel for grants or Organization+Member for Role/activation; no-op grants skip them. Only the 30 s fallback scans all, avoiding cross-tenant work/failure propagation.
- #149 subscriptions follow the current access path: public non-Guests ignore redundant grants; a Role change requiring a grant captures its lifetime. Reason: continuous access must survive promotion and redundant removal.
- #149 API mutations lock Organization, Channels (ascending id), Members, grants, then #142 Unread serialization/shared #135. Sends lock Member/grant through COMMIT before exclusive #135; mark-read releases its watermark barrier before Member/grant/position locks.
- Private Channel creation takes Organization NO KEY UPDATE before creator Member and new rows, so #231's Channel set stays stable; creator grants stay atomic and Organization-scoped. Listing batches visibility/Unread in one snapshot, `no-store` (#22, #142).
- Inaccessible Channels return the same 404 for reads and sends, so private Channels are not disclosed (#17).
- Channel names are unique per Organization across visibility, `lower(name COLLATE "C")` (ASCII folds, non-ASCII as-is); duplicates 409. Existing duplicates fail the migration for the operator to resolve; no auto-rename (#51).
- Accepted (#51): a 409 on creation lets an Organization Member infer a private Channel name exists (names only, no members or messages).
- #299 Channel names are 1..=128 Unicode scalars, NUL-free (400 before a write transaction); Rust, PostgreSQL CHECK and OpenAPI enforce length. Empty-name acceptance is superseded. Reason: usable names and the unique btree entry limit (#63).
- #299 migration validates existing rows before replacing the CHECK; violations abort, preserving rows. No automatic rename/truncate/delete. Stop Channel writes; run `SELECT organization_id, id, name FROM channels WHERE char_length(name) NOT BETWEEN 1 AND 128`; correct and re-run until empty.
- #63 accepted lock: the plain CHECK validates rows under ACCESS EXCLUSIVE during ALTER, also blocking reads; acceptable at current scale.
- Channel names with leading/trailing `str::trim()` whitespace are rejected (400), never trimmed: trimming changes what was typed, invisible differences allow look-alikes (#72). Checked in the API, not a DB CHECK: PostgreSQL whitespace differs from Rust (#77).
- Per-Channel seq comes from a messages-owned counter row updated in the insert transaction, not a PostgreSQL sequence, so a rollback consumes no number. Cost: it serializes writes to a hot Channel (#17).
- Idempotency key (organization_id, sender, client_message_id): a match returns the canonical Message, a different body/Channel/Topic name_key/reply target 409; a concurrent duplicate rolls back its allocation before reading the winner (#17).
- Message body: 1..=4000 Unicode scalars (the spec sets no limit), no NUL, not whitespace-only, never trimmed (whitespace counts for idempotency); 400 before seq allocation (#17, maintainer-approved).
- Sends re-check Member/revision/private grant after BEGIN and hold a shared Member row lock through COMMIT, so deactivation cannot commit between authorization and persistence. Channel creation keeps the same lock (#146 review).
- History reads authorization and its page in one read-only REPEATABLE READ transaction without row locks: loss committed before the snapshot denies; an authorized page sees no later Messages (#146).

## Topics, Replies and Unread (planned, spec P1-P8)
- A Topic is created by its first Message (or a Move to a new Topic); empty Topics do not exist. The main-timeline Topic line is a derived display that moves with the Topic's latest activity (maintainer, 2026-11-10, #148).
- Main-timeline paging correctness (`position_W`, W as page anchor) is fixed in the spec; its cost is a measured feasibility gate in #137 that stops and asks on a miss, not a guarantee (maintainer, 2026-11-11, #148).
- Topic counts are an as-of-W baseline plus deduplicated live Messages with `seq` > W; a Topic seen only live has no count until a summary fetch. Reason: replay below W or late older pages must neither double-count nor drop the baseline (#148).
- Unread keeps a Channel position (Messages without Topic) and per-Topic positions; badge = sum. Initial position = latest committed `seq` when the Member gains access; older history is not unread (maintainer, 2026-11-11, #148, #142).
- #142 Messages owns read positions. Migration/grant triggers capture the committed counter at access time, discard revoked positions and initialize existing Topics; later Topics inherit the grant baseline. Reason: first-fetch initialization loses Messages sent after a grant.
- #142 access triggers serialize per Organization (seed 142) so Member/Channel creation cannot miss initialization. New grants hold shared #135 through COMMIT. Mark-read rechecks access after W, locks Member/position; revocation deletes positions, denying a waiting update.
- #142/#144 triggers mirror Channel visibility, including Roles and current public/private grants on reactivation; changes to visibility must update both predicates. The position/visibility equivalence test guards this duplication without reversing module ownership.
- #142 list counts range-scan messages_topic_seq from read positions, skipping fully read Topics by last_seq: O(Channels + Topics + unread-range Messages), independent of read history. Own Messages in those ranges are filtered; see measurements.md.
- #142 missing positions suppress only that Channel's Unread at committed seq (Topic projections: W), with a list error log; reads persist nothing and mark-read stays 404. Zero would mark all history unread; a list-wide 500 would hide unaffected Channels.
- #144 Role/grant changes reconcile positions under #142 serialization: only newly visible Channels initialize through #135; continuous access keeps Channel/Topic positions. This avoids resetting Unread on redundant grants or Owner/Admin/Member changes.
- #142 access changes serialize per Organization: public Channel inserts are set-based O(active Members + their Topics); Member activation is O(visible Channels + Topics), retaining shared #135 locks until COMMIT. Accept at current scale; remeasure larger Organizations.
- #142 backfill blocks sends, Member and grant writes under SHARE ROW EXCLUSIVE; work scales with visible Member×Channel pairs plus their Topics. Startup lock acquisition times out at 5 s; once acquired, a large backfill can extend the write outage.
- Move, Edit, Delete (principles only, #148): clients apply entries idempotently; a later change takes a Channel log position. Open: replay of a changed Message (current or as it was), of a deleted one, read positions after a Move. `channel_events` vs `channel_log`: Sprint 3 (#160).
- #151 DM is a Channel kind for one immutable, Organization-scoped Member pair; no name, visibility, Topics or manager right. Reason: reuse seq, Replies, sync and Unread without making private-Channel management apply to DMs. Contract: docs/spec/dms.md.
- #151 POST /dms opens or renews one pair; GET /dms lists only accessible DMs with peer identity and Unread/Mention hooks. Ordinary Channel lists/sections exclude DMs. Reason: a DM has no Channel name or Topic navigation.
- #151 new sends hold peer eligibility through COMMIT: inactive peer gives 409 dm_peer_deactivated, active lapsed grant gives 409 dm_peer_access_lapsed (2026-11-14). Authorized committed retries resolve first. Reason: sending never renews access or undoes an accepted send.
- #151 DMs reject Topic intent and member/grant APIs; all management Capabilities deny. Exclude DMs from RoleChangeGuard and last-manager/grant counts. Reason: fixed two-person participation must neither confer management nor block Role changes.
- Mention gets its own counter, separate from Unread (#148).

## Topics (#137, #138)
- Messages owns Topics, nullable messages.topic_id and their atomic send updates; composite FKs bind a Message's Topic to its Organization and Channel. #139 appends its own migration, preserving #137's migration.
- Topic names: 1..=60 Unicode scalars; reject empty, NUL, whitespace-only or surrounding str::trim() whitespace (400), never trim. Per-Channel lower(name COLLATE "C") uniqueness folds ASCII only; keep the first display name. This differs from Channel rules.
- Topic creation/join, Message, seq and summary commit together inside existing bounded send admission. Retry identity adds the Topic name_key (null without Topic); changed intent is 409. Lost-response retries need no server Topic UUID.
- Topic reads use #135 watermark admission/barrier only to fix or validate W, then release both before a fresh authorization/data snapshot bounded by W. Aggregates use the shared pool without separate admission; admission rejection is 503 with Retry-After. W never expires.
- #137 paging gate met with mixed Messages and concurrent sends: release recent/deep p95 32.342/32.235 ms at 210k Channel Messages, four readers; send p95 11.249/6.345 ms. Keep prefix aggregation/index; proportional 100 ms crossing ~649k Messages needs remeasurement. Conditions: measurements.md.
- topics.last_seq/message_count are a write-only cache retained for #142/#143; immutable Message aggregates supply W-relative summaries, because current cached values cannot reconstruct an older W (#137).

## Replies (#139, #140)
- Replies store a committed parent id and stable root, inherit its Topic, and share send admission/barrier/transaction/publication. Scoped parent/root FKs and a self-parent CHECK protect references; committed immutable parents prevent cycles.
- Retry identity compares reply_to before parent lookup; inherited Topic is not client intent. Same-key retries stay canonical and changed parents conflict without an existence leak.
- Chain reads union an indexed root lookup and limited reply_root_id/seq range, including the null-root Message without recursion. Resolve ambiguous COMMIT, then authorize/read a fresh snapshot; no cross-page W or depth cap.
- DeferredOrganizationAuth rejects Session/database errors before reading a send body but carries Organization loss to input validation. This implements #139's 400-before-404 precedence without weakening 401 or admission authorization.
- #139 accepts deploy-time locks/scans for plain indexes and validated FKs/CHECKs on messages at current scale, like #63; migration lock timeout bounds waiting, not scan time. The chain index excludes non-Replies to reduce write/storage cost.
- reply_root_id consistency is application-enforced: each Reply stores its parent's root (or the parent if it is a root), whose reply_root_id is null. Future chain-moving writers (#141) and repairs must preserve this; scoped FKs alone do not.
- #138: opt-in Topic composition bootstraps sync with the real Message at W from the initial timeline; later projection pages stay outside sync. Reason: preserve the existing unfiltered cursor/gap protocol and avoid component conflicts during the UI follow-up.
- #140 keeps one opt-in chain per Channel, merged by Message id and stable reply_root_id. Page continuation uses only the last page seq; live appends cannot skip unpaged siblings or enter sync cursor/gap evidence.
- #140 composes over sync (or Topic sync) and sends confirmed-parent Replies through its existing pending/retry path. Preserve reply_to with the id/body so retries cannot change intent; projection reads settle C5 with session/read fencing before teardown.

## Send limit (#306)
- Per-(Organization, Member) bucket, burst 10, 1/s, initial 10 (maintainer, 2026-11-13): a person types well below 1/s sustained, bursts cover pastes and retries, and one Member or stolen session can no longer fill a Channel's 256-waiter queue for others.
- The limiter runs after Channel authorization and before admission, so denials stay 404 and a 429 takes no slot, sequence or event. Committed retries answer before it after an access recheck (S5), so an exhausted bucket never blocks recovery.
- Charge on passing the limiter, no refund: a refund would let failing sends (missing parent, rollback) loop free. COMMIT-unknown and in-flight duplicates are not charged again, so a client retrying per C6 never pays twice for one outcome.
- Database failures other than a definite rollback count as COMMIT-unknown: conservative, since an extra free retry within 120 s costs one send at most, while a double charge would throttle honest C6 retries.
- Bounded state, fail closed (503, Retry-After 1, uncharged): buckets <=100,000 at ~70 B (~7.5 MiB with table growth); a bucket is dropped only when refilled to full, equal to a fresh one, so eviction never resets debt.
- Pending keys <=10,000 at ~200 B incl. the watch channel (~2 MiB), 16 waiters each; unknown markers live 120 s. In-process only, matching the single-process deployment (`docs/decisions/process.md`).
- Identical waiters take the executed leader's outcome (canonical, else its failure), never re-execute: that would pay again or spend the free retry. Only a charged unknown COMMIT earns a marker, so retries cannot chain. Another intent on the key inherits neither.
- A leader that paid but was refused before persistence (admission 503) hands that refusal to identical waiters; releasing them instead let each pay again, breaking one charge per concurrent identical send (#349 review). Another intent still begins again.
- Burst and refill are operator env settings (maintainer, 2026-11-13) so CI load/e2e can send fast from one Member; defaults stay 10 and 1/s and Compose keeps them. Only the size changes: order, idempotency, caps and 503 fail-closed are fixed. CI numbers are not production-limit measurements.

## Entries in other parts

- [load](load.md): `#151 adopts DM performance acceptance`

- [auth](auth.md): `#151 DM access needs`, `#151 explicit non-Guest open`, `#151 peer eligibility belongs`
- [realtime](realtime.md): `#151 dm_list_changed targets`, `#151 DM discovery reuses`, `#151 DM list responses`, `#151 DM list base limits`, `#151 B4 adopts`, `#151 coalesces discovery`

- [auth](auth.md): `#314 single-statement hot reads use`
- [auth](auth.md): `#299 shared raw-text validation`
