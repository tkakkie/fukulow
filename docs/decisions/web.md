# Decisions: web

Web client. Writing rules and the other parts: [index](../decisions.md).

## Web client
- #91/#94 real-time sync contract: OpenAPI types cannot express delivery/reconnect, so it lives once in `docs/spec/realtime.md` (server guarantees with tests; client rules as target). C8 excludes restored history past the old cursor; a history-generation id is deferred.
- Web sync is layered (components, adapter, controller, pure protocol, API/transport) so ordering and dedup are testable without Svelte or I/O; only message sync has a protocol (#91/#94). No CI layer check yet (needs a negative test).
- Capabilities (`{allowed, reason?}`) come from authorize: Organization invite/manage-Roles/create-Channels, Channel add-Members (#144). Server requests re-check independently; #149 owns Channel management endpoints.
- #120: an async `channel_not_found` carries no subscription generation; if it could belong to a retired or a pending subscription, the controller reconnects with backoff. Cost: one resubscribe of all Channels; other clients must do the same.
- #97 Svelte 5 adapters only read the controller and forward intents; `createSubscriber` carries change notifications, so state is never copied into `$state`. Session controllers live from Sign in to sign-out/4001/401/replacement, closed by the auth adapter.
- #195: reconnect uses full jitter [0, min(10 s, 500 ms * 2^attempt)), including the first 4008; only subscribed resets attempts, avoiding handshake retry loops. 4001/4003 remain terminal. History fill keeps deterministic backoff; injected randomness permits exact tests.
- #146/#148 client classification: 4001 Sign in; 4003 terminal Organization unavailable; 1001/1011 back off and reconnect; 4008 reconnects with bounded retries. A rejected browser handshake never implies 4003 (`GET .../me` confirms).
- #144 explicit Organization re-selection REST-checks Membership and starts fresh sync only on success, allowing re-invites without sign-out. Failure never loops; old pending sends and work stay fenced, including same-Account vs replaced-Account 401 handling.
- The auth adapter keeps Account/controller lifetime and Organization selection together (Tier 2 deviation) to avoid an unrelated abstraction in the #146 migration; sync policy stays in the controller/protocol.
- #200 layout A2 (rail, チャンネル column with トピック accordion, main card, closable right panel), picked by the maintainer from three mockups; surfaces split by tone and radius, not rules. Details in `docs/ui.md`.
- #200 navigation uses the History API and the existing SPA fallback, with no router dependency: one entry per view or panel layer; in-app back/close controls replace instead of popping, so they never change main or leave the app. URLs are hints; the API decides access.
- #200 drafts live in controller memory per target for the Account Session, never in web storage; theme and text size are the only planned `ui-settings.ts` keys (enum values, per device, #48).
- #242 draft-store epochs fence ended Account Sessions; target revisions protect edits across Organization controllers. Observe detached sends only to restore definite refusals after a switch: the old failed Message UI is gone; ACKs and unknown outcomes never restore text.
- #200 skips `@axe-core/playwright` and checks WCAG 2.2 AA token contrast, token-only component styles and single polite status-region structure in vitest (`ui-tokens.test.ts`), avoiding a new dependency while running in fast CI.
- Sprint 1 web acceptance: `npm --prefix web run e2e:compose` against `docker compose --profile caddy up` from an empty database (#19).
- #211: Compose browser acceptance runs on main pushes and manual dispatch, never PRs, keeping image/browser costs off PR feedback. #150 Sprint 2 requires a successful manual dispatch on the release candidate. Use Caddy for HTTPS/WSS; ci.yml covers both proxies.
- #211/#254: upload only allowlisted report.json on failure (3 days). No traces, ARIA snapshots or raw requests; screenshots can expose the setup token, and unfiltered sqlx errors prevent certifying Compose logs as secret-free.

## Entries in other parts

Entries that also govern this area, listed by the start of the entry in that part.

- [process](process.md): `Web boundary check (#48, #60): Workers/SharedWorkers`, `Web storage is forbidden everywhere. A`, `Hand-written API types are review-enforced, not`
- [auth](auth.md): `#197 app-wide CSP allows external same-origin`, `#197 Vite manifest outputs alone get`
- [messages](messages.md): `#138: opt-in Topic composition bootstraps sync`, `#292 last_channel_manager counts both kinds`, `#140 keeps one opt-in chain per`, `#140 composes over sync (or Topic`
- [realtime](realtime.md): `#148 fixtures for behaviour not implemented`, `#161: queue-cap rejection and 30 s`, `A dropped connection or response timeout`
