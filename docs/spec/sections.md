# Spec: Sections

Index and Terms: [docs/spec.md](../spec.md).
Related: [effective access](accounts.md#members-roles-and-invites), [personal notices E1–E6](realtime.md#personal-section-notices-204-specified-not-implemented), [left column and Japanese copy](../ui.md).

## Personal sections (#204, specified, not implemented)

- Q1. A **section** is a Member's named, ordered collection of Channels in one Organization's left column. Every active Role, including Guest, manages its own sections. Layouts are independent per Member/Organization. There are no shared, Organization-default or admin-managed layouts, and nobody else, including Owner/Admin, can read or change them.
- Q2. One implicit **Other Channels** group (`その他のチャンネル`) follows all custom sections. It has no id or mutable name and cannot be created, deleted or reordered. Keep empty custom sections visible and hide the empty implicit heading. Names may repeat, including the localized default. Only ids identify sections. Each Channel has at most one stored group and position per Member/Organization. Unplaced Channels belong to Other Channels.
- Q3. Use the Member's complete custom-section order. Within a group, explicit placements precede automatic placements. The automatic Other Channels tail uses existing Channel-list order, `lower(name COLLATE "C"), id` (ASCII-only fold, UUID tie break). Create appends a section. Changing groups appends a Channel after explicit placements and before the automatic tail. Moving to its current group preserves placement and order. Reorder uses complete lists. Internal ordering keys never enter the API.
- Q4. Read effective access afresh from `authorize`. Active current-revision Owner/Admin/Member can access public Channels or Channels with usable grants. Private Channels and public Guest access require usable grants. Return only accessible Channel ids, without hidden ids, names, counts, placeholders, gaps or order keys. Owners see their own section metadata even if all its Channels are hidden. Channel names and badges come from the authorized Channel list. Sections confer no access. DMs are excluded [under D1/R4](dms.md).
- Q5. Observed loss immediately hides the Channel in every group while preserving its stored group/order. Regain restores its place unless the Channel or section was deleted. Clients omit hidden ids, and reorders preserve them. Removing a redundant public grant for Owner/Admin/Member preserves access and placement. Deactivation retains layout on the preserved Member identity. Reactivation restores no grants. Only effective access reveals placements. Unread positions follow P8 and may reset on re-grant.
- Q6. Section deletion atomically clears all its placements, including hidden ones. Its Channels become unplaced in Other Channels, appearing only with access. Future Channel deletion must atomically clear all Members' placements before that feature ships. Q10/E1 govern silent cleanup of hidden placements. Personal operations change no Channel, grant, Membership, Role, Message, Unread position or subscription.
- Q7. The `channels` module owns layout rows and SQL. Auth owns Member authorization. An append-only migration enforces `organization_id NOT NULL` on every layout, generation and create-retry row. Use same-Organization Member and Channel FKs. A custom placement references the unique section key `(organization_id, member_id, id)`. Unique `(organization_id, member_id, channel_id)` prevents default/custom duplicates. Section/Channel deletion leaves no dangling references. Composite-target and cleanup indexes and Organization RLS/context apply. Direct SQL rejects cross-Organization and cross-owner references independently of API checks. Unset/foreign context denies.
- Q8. Serialize mutations atomically per Member/Organization through COMMIT. Reads see complete committed state. Concurrent moves leave one complete placement. Move versus section delete leaves a surviving placement or moves it to Other Channels. If the destination was deleted first, fail without writing or recreating it. Concurrent complete reorders of the same current set use last-committing-writer-wins without duplicates, omissions or an order-version check. If create/delete/move/access changes the required set, refuse the entire reorder with `409 section_layout_changed` unless an earlier ownership/access 404 applies. No partial application or automatic merge.
- Q9. Lock Organization → affected Channels by ascending id → Members by ascending id → grants → personal layout rows (#149/#311). Hold fresh actor Role, active Membership/revision and required grant authority through COMMIT, including retries and no-ops. Discover sets before later locks, revalidate under lock and restart or return the set conflict on change. Skip unused stages, never take an earlier lock afterwards. Section-only changes skip Channel/grant locks when they neither authorize nor modify placements. Channel deletion locks all affected Members before cleanup. Recipient reads after COMMIT take no row locks (A5).
- Q10. Each Member/Organization has a durable exposed `generation`, initially zero. Advance once per transaction changing section metadata/order or Channel placement/order. During Channel deletion, test access in the locked pre-deletion state. Advance generation and publish only for affected Members with effective access. Removing a hidden placement is atomic and invisible, including no generation change, notice, reset or close. Holding a placement proves no access. No-ops, denials and rollback advance nothing and publish nothing. Access changes alone never advance layout generation. They use the separate A9–A12 access generation. GET uses one read-only REPEATABLE READ snapshot for generation, order, effective access and current Membership/revision, without Member row locks. Prior loss denies or filters. An earlier authorized snapshot may finish under E5–E6 fences.

## REST contract

All routes start `/api/v1/orgs/{org}`, with UUID Organization, section and Channel ids. Use existing cookie/bearer Session authentication. Resolve the active owner Member from the URL, with no owner/Member field or administrative override. Reject unknown request fields. Every response, including errors and empty successes, is `Cache-Control: no-store`. No query parameters.

REST and notices encode `generation` as a canonical unsigned decimal string (zero or no leading zero, maximum `9223372036854775807`), compared numerically. It is a snapshot version, independent of Channel seq, grant lifetime and authorization. It never wraps or repeats during normal database lifetime. After restore, require a fresh socket and reconciliation epoch before accepting a lower baseline. Unnoticed rollback within the existing connection is outside the contract (C8).

All fields below are required. Arrays are ordered and ids unique. `null` section id means Other Channels, whether explicitly placed there or unplaced. Layout contains all the owner's custom sections, including empty ones, and every effectively accessible ordinary Channel exactly once. It has no pagination, hidden-placement metadata or Channel representation. Render the intersection with the authorized Channel list (E5–E6).

```text
Section = { id: UUID, name: string, channel_ids: UUID[] }
SectionLayout = { generation: decimal-string, sections: Section[], other_channel_ids: UUID[] }
SectionSnapshot = { generation: decimal-string, section: Section }
ChannelPlacement = { generation: decimal-string, section_id: UUID | null }
CreateSection = { id: UUID, name: string }
RenameSection = { name: string }
SectionOrder = { section_ids: UUID[] }
ChannelOrder = { section_id: UUID | null, channel_ids: UUID[] }
MoveChannel = { section_id: UUID | null }
CreatedSection = { id: UUID, generation: decimal-string }
ErrorBody = existing { error: string }
```

| Method and suffix | Request | Success |
|---|---|---|
| GET `/me/sections` | none | 200 `SectionLayout` |
| GET `/me/sections/{id}` | none | 200 `SectionSnapshot` for own section |
| POST `/me/sections` | `CreateSection` | 201 `CreatedSection` or 200 canonical retry |
| PATCH `/me/sections/{id}` | `RenameSection` | Empty 204, including a reauthorized unchanged name |
| DELETE `/me/sections/{id}` | none | Uniform empty 204 for own deletion, absent, deleted or foreign-owned id |
| PUT `/me/sections/order` | `SectionOrder` | Empty 204. Reserve the static path before parsing UUIDs |
| GET `/me/channel-sections/{channel_id}` | none | 200 `ChannelPlacement` |
| PUT `/me/channel-sections/{channel_id}` | `MoveChannel` | Empty 204 under Q3 |
| PUT `/me/section-channel-order` | `ChannelOrder` | Empty 204 |

- R1. Names have 1..=60 decoded Unicode scalars, no NUL, no surrounding Rust `str::trim()` whitespace and at least one non-whitespace scalar. Reject without trimming/normalizing. Preserve internal whitespace and case. Atomically cap creation at 50 live custom sections per Member/Organization, including empty/hidden-only sections. Exclude Other Channels and retired ids. Canonical retry uses no new slot.
- R2. Limit actual JSON bodies to 16 KiB, except 1 MiB for `PUT /me/section-channel-order`. Limit `SectionOrder` to 50 ids and `ChannelOrder` to 20,000 ids. Empty arrays are valid for empty current sets. Groups above 20,000 Channels need a capacity decision. Never truncate or partially reorder.
- R3. Include every current custom section id or every accessible Channel id in the selected group exactly once. Reject duplicates. Section order rejects unknown/deleted/foreign ids before set equality. Omitting a current owned section gives `section_layout_changed`. Channel order includes the automatic tail and cannot move Channels between groups. Form slots from the stored explicit sequence plus accessible unplaced tail, keep hidden slots fixed, and fill the rest in submitted order as explicit placements. A missing or extra accessible id (including one moved to another group) gives `section_layout_changed`. An inaccessible supplied id denies first. Refetch after a set conflict before submitting an intentional full order.
- R4. POST persists the client-generated id and exactly the original name atomically per owner/Organization. While live, a matching retry returns id and current generation without undoing rename/order. A different original name gives `409 section_id_conflict`. Concurrent identical creates make one section. Deletion retains private scoped retired-id metadata and every reuse gives `409 section_deleted`, preventing resurrection. Ids may coincide across owners without conveying authority or data.
- R5. Rename, move and reorder set desired state. Repeat of current state is a no-op after reauthorization and set validation. An older intent after an intervening write is a new last writer. Serialize local intents. After unknown outcome, refetch and ask the user to reapply if needed. DELETE is safely repeatable. Only POST canonically retries the original id/name. Dirty the layout target (E4) after success or unknown outcome. ACKs alone never add displayed Channels.

### Refusals and precedence

Authenticate Session → parse Organization UUID → resolve current Membership/revision → validate remaining path/body → resolve ownership and access. Writes recheck authority in the transaction before any effect, including after waiting on locks. A stale revision cannot borrow reactivated authority. Resolve an owned section before exposing contents. For placement GET/move, authorize Channel before destination. For Channel reorder, resolve the owned group, authorize every supplied Channel, then check set equality. Denials/conflicts write and publish nothing.

| Refusal | HTTP status and `ErrorBody.error` |
|---|---|
| Missing/invalid/expired/revoked Session | 401 `invalid credentials` |
| Unknown Organization, non-Member, inactive/stale Membership | 404 `organization_unavailable` |
| Malformed JSON/UUID, missing/unknown fields, wrong types/nullability | 400 `invalid input` |
| Invalid name | 400 `invalid_section_name` |
| Duplicate/too many order ids | 400 `invalid_section_order` |
| Byte limit exceeded | 413 `request body too large` |
| Unsupported content type | 415 `expected application/json` |
| Unknown/deleted/foreign-Organization/other owner's section in GET/PATCH, move destination or reorder | 404 `section_not_found`. DELETE stays 204 |
| Unknown/foreign-Organization/inaccessible supplied Channel, including guessed hidden placement | 404 `channel not found` |
| New create exceeds live-section cap | 409 `section_limit` |
| Conflicting original name / retired id | 409 `section_id_conflict` / `section_deleted` |
| Reorder id set differs | 409 `section_layout_changed` |
| Internal/DB failure, including generation exhaustion | 500 `internal error` |

Errors contain only the stated value, without names, owner ids, hidden ids/counts or conflicting layout. Owned layout/section reads succeed with inaccessible Channels omitted. Direct placement reads deny with the same error as for unknown Channels. No additional 403, management permission or Owner/Admin exception.

## Left-column behaviour

Apply [UI rules](../ui.md). Custom sections and Other Channels start expanded and collapse using keyboard-operable heading buttons with `aria-expanded`. Visible Channels retain Topic accordions. Offer `セクションを作成`, `名前を変更`, `上へ移動`, `下へ移動`, `セクションを削除` and `チャンネルを移動`, including `その他のチャンネル` as a destination. Move/reorder needs visible keyboard controls. Keep focus on a moved item. After deletion focus the next section heading, then previous, then Channel-list heading. Collapse state is local memory only, with no synchronization or web storage. Collapsing changes no placement, access, subscription or Unread. Empty custom sections remain editable/deletable.

## Verification and recovery

Every denial test pairs with an authorized positive control and asserts unchanged layout/generation, no protected disclosure and no publication. Cover other owners (including Owner/Admin actors), other Organizations, private non-grantees of every Role, public Guests without grants, revoked grants, demotion to Guest, inactive and stale revisions. Check omission on layout/single-section reads and denial on placement GET, move and reorder, including after initial authorization and while awaiting locks. Positive controls use current grants. Hidden Channel cleanup leaves the former viewer's layout and single-section responses and notice/reset/close behavior indistinguishable from no deletion. An authorized placed Member gets one generation increment and a notice.

Use the single #307 O5 schedule for hidden retained and visible layouts, with its provisional 30 s period changed only by #307 item 5 measurements. Early successful reads never complete recovery from later COMMIT, including after re-registration, reconnect or process restart with a surviving database backend. [E1–E6](realtime.md#personal-section-notices-204-specified-not-implemented) define authorized recipients, proof and recovery on lost notices, publication-capacity refusal, failed/timed-out authorization, cancellation and lost COMMIT reply. Pause before query completion/enqueue/first handoff to verify loss/reactivation cannot revive old work. Unproven recipients receive no mutation-triggered notice, reset or close. Own authorized sessions converge on O5 even when no reset was possible. Add executable tests and invariant rows with implementation (#204).
