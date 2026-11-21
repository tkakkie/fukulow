# Decisions: web

Web client. Writing rules and the other parts: [index](../decisions.md).

## Web client
- #409 Separate Rust Reply totals track any chain member. At 400 evidence records, checkpoint floors/root generations before refetch so paging, duplicates and stale snapshots do not change authority. Keep protocol state out of Svelte.
- #409 Count reads need a cursor and confirmed subscription to cover history-only Replies. Recovery preserves Retry-After/backoff so gap recovery respects server throttling. Bound expiry/omission retries per root independently of other successes. Invalid tickets leave the rest of the batch usable.
- #409 New top-level creates above the cursor seed zero at `created_seq`. Panel roots lead batches. Reconcile changed Channels only and retain unchanged JS root-set/total identities to avoid POSTs, wasm calls and renders while preserving ordering.
- #465/#467 Sole Rust/wasm core keeps recorded and seeded TS-oracle contracts. Vite requires wasm and glue. Mount shell during load, start sync afterward and surface load failure. Dispatch notifies before ordered effects.
- #465 A matched format probe favored JSON. Deltas preserve unchanged JS Channel/array identities and retained Message indices, interning body text once per step. Bounded request/timer reads keep State in Rust. #466 acceptance is separate.
- #727 WebSocket stays JSON for contract parity and debuggability. If milestone measurement shows bulk receive is heavy, first hand received text to wasm without the JS parse/stringify round trip, then re-probe non-JSON wasm output (rejected in #465), and make frames binary last.
- #465 Manifest-listed build outputs, including wasm and glue, get immutable caching. Wasm uses `application/wasm`. CSP adds only `wasm-unsafe-eval` for compilation without general `unsafe-eval`. Both proxies need browser coverage. [Deployment contract](../spec/deployment.md#deployment-194-c)
- #308 bounds Topic/Reply/cursor evidence at 400 ranges and Unread at 1,100 records/presented seqs, 400 Topic scopes and one visit marker. Checkpoint/refetch baselines, keep insufficient counts unresolved and refill forgotten gaps to bound arrival-driven growth.
- #308 uses 400 main/300 Topic/200 Reply display records, five inactive Channel slots of 50 and shared sync budget 600. Maximum 1,500 records reserves room for simultaneous main/panel histories. Pending sends are exempt.
- #308 Dependency-free variable-height windowing uses ResizeObserver on attached rows, one IntersectionObserver for presentation, ID-based offscreen focus and CSS custom properties for spacer geometry.
- #308 refetches older main pages at fixed W, newer history with a fresh first page and older Replies from the root. Evidence checkpoints/evicted Topic excerpts use existing summary reads, with no API extension. Topic-list positions cannot prove main coverage. Requested Reply history outranks cached recent bodies. Pending intents retain roots through settlement/discard to avoid skipped history or hidden unresolved sends.
- #301 Rebuild identity Map on Member list fetch, without poll/push. Batch unknown authors at 100. Retry omissions/failures only on list load, Channel selection or reconnect. Keep accessible `（無効）` for deactivated names. `members.load()` is #315’s refetch hook.
- #300 Share a cookie-mutation guard across sign-in/out, Invite acceptance and setup plus atomic Account transitions because ignoring Set-Cookie does not prevent mutation. Generation-fence reads without retaining busy so sign-out/retry can proceed while stalled.
- #300 Invite session 401 offers explicit sign-out and retains Invite in memory. Only 204/401 restores form for manual resubmit. Network/5xx preserves error and never accepts. This recovers stale cookies without anonymous downgrade and retains existing-Account sign-in.
- #91/#94 OpenAPI covers types. [Cross-client behaviour](../spec/realtime.md) covers ordering/recovery. Layers (components, adapter, controller, pure protocol, API/transport) test ordering/dedup without Svelte/I/O, with a protocol only for message sync. A CI layer gate needs a negative test. #515 C8 Organization epochs detect restores beyond old cursors and require operator rotation before traffic.
- #144 `authorize` supplies operation Capabilities for Organization invite/manage-Roles/create-Channels and Channel add-Members. Server rechecks independently. #149 owns Channel management endpoints.
- #120 Async `channel_not_found` carries no subscription generation. If it could belong to a retired or pending subscription, every client reconnects with backoff at the cost of resubscribing all Channels.
- #97 Svelte 5 adapters observe with `createSubscriber` and forward intents, without copying controller State into `$state`. Controllers live from Sign in. The auth adapter closes them on sign-out, 4001, 401 or replacement.
- #195 Reconnect uses full jitter [0, min(10 s, 500 ms × 2^attempt)), including the first 4008. Only `subscribed` resets attempts to avoid handshake loops. History fill uses deterministic backoff. Injected randomness enables exact tests. #146/#148 4001 ends the Account Session and prompts Sign in, 4003 makes only the Organization terminally unavailable, 1001/1011 back off/reconnect, and 4008 retries are bounded. Browser handshake rejection alone never implies 4003. REST `GET .../me` confirms.
- #144 Explicit Organization re-selection REST-checks Membership and starts fresh sync only on success, allowing re-invites without sign-out. Refusals never loop and old sends/work stay fenced, with same-Account and replaced-Account 401 handled separately. #146 kept Account/controller lifetime and Organization selection in the auth adapter (Tier 2 exception) to avoid unrelated abstraction. Sync policy stays in controller/protocol.
- #200 Maintainer chose A2 of three mockups: rail, チャンネル column with トピック accordion, main card, closable right panel. Tone/radius separate surfaces without rules. [UI](../ui.md)
- #200 Use History API and SPA fallback without router dependency, one entry per view/panel layer. App back/close replaces so main stays put and the user stays in-app. URLs are hints. API authorizes.
- #200 Keep per-target drafts in Account Session controller memory, never web storage. #48 permits only device-local theme/text-size enums via `ui-settings.ts`. #242 Draft epochs fence ended Sessions and target revisions preserve edits across Organization controllers. Observe detached sends only to restore definite refusals after a switch, when the old failure UI is gone. ACKs/unknown outcomes never restore text.
- #200 Vitest checks WCAG 2.2 AA token contrast, token-only component styles and one polite status region in fast CI without adding `@axe-core/playwright`. [Web invariants](../invariants/web.md)
- #211: Compose browser acceptance runs on main pushes and manual dispatch only, keeping image/browser costs off PR feedback. Both profiles use Pebble HTTPS/WSS. `ci.yml` retains PR security checks.
- #211/#254: upload only allowlisted report.json on failure (3 days). No traces, ARIA snapshots or raw requests. Screenshots can expose the setup token and raw sqlx errors keep Compose logs out of artifacts.
- #266 Keep Unread reconnect/equal-baseline fixtures proposed and reference-merge only. Reverse responses require concurrent reads, whereas the web controller serializes Channel-list fetches and tests that path separately.
- #413 Desktop notifications (approved 2026-11-19): each tab decides alone, without `BroadcastChannel`, so duplicate notifications across tabs are accepted. Text is DM or Mention only, never body or sender. One 50-event `/events` page per read; skipping the tail is accepted because only confirmed events notify and Unread is untouched. A Topic Mention read on another device may notify once; the main `read_seq` is never a Topic read proxy. The implementation must load-measure the extra REST reads and confirm a bound. Setting persistence, Service Worker and Push are separate Issues.

## Entries in other parts

Entries that also govern this area, listed by the start of the entry in that part.

- [messages](messages.md): `#152 proposes exact`, `#152 Mention counts share`, `Mention unread is a separate displayed count`
- [realtime](realtime.md): `#152 Mention counts inherit`

- [messages](messages.md): `#151 DM is a Channel kind`, `#151 POST /dms opens`, `#151 new sends hold`, `#151 DMs reject Topic intent`
- [auth](auth.md): `#151 DM access needs`, `#151 explicit non-Guest open`, `#151 peer eligibility belongs`
- [realtime](realtime.md): `#151 dm_list_changed targets`, `#151 DM discovery reuses`, `#151 DM list responses`, `#151 DM list base limits`
- [messages](messages.md): `#160 Event position and Message`, `#160 Required before any mutation`
- [messages](messages.md): `#204 sections belong`, `#204 access loss hides`
- [realtime](realtime.md): `#204 sections_changed goes only`, `#204 section notices share`, `#204 section display intersects`

- [process](process.md): `Web boundary check (#48, #60): Workers/SharedWorkers`, `#48 Forbid web storage except`, `Hand-written API types are review-enforced, not`
- [auth](auth.md): `#197 app-wide CSP allows external same-origin`, `#197 Vite manifest outputs alone get`
- [auth](auth.md): `#401: app and both proxies send`
- [auth](auth.md): `#300 sign-out 401 expires current`
- [messages](messages.md): `#138/#515 Topic composition passes`, `#292/#311: a private`, `#292/#311 The right lives`, `#292/#311 last_channel_manager counts`, `#140 keeps one opt-in chain per`, `#140 composes over sync (or Topic`
- [realtime](realtime.md): `#148 fixtures for behaviour not implemented`, `#161: queue-cap rejection and 30 s`, `A dropped connection or response timeout`

- [messages](messages.md): `#311 PATCH /api/v1/orgs/{org}/channels/{id}/members/{member_id}`, `#311 Manager PATCH uses`

- [auth](auth.md): `#304 recheck current Session/password under locks`, `#304 wrong current password is 403`

- [auth](auth.md): `#303 management follows`

- [messages](messages.md): `#515 uses Organization UUID epochs`
