# Invariants

Record critical guarantees, cross-cutting rules and denials whose full scope exceeds code, tests and `openapi.json`. State each Rule's scope and exceptions. Cite `path::test_name` that runs in CI. Add it with the code. [One home per fact, update by replacement or merge](workflow.md#13-splitting-a-doc).

E2E needs a final pass in the CI Playwright report (retry pass counts). Static checks still apply. Use file and leaf title as in the static check. Reject duplicate report identities.

File rows by main area in `docs/invariants/`. Read touched parts. Optional "Rows in other parts" are checked. Cite a unique test name within the part. If none is unique, start the Rule with `{#id}` (lowercase words and hyphens). Use IDs only for rows referenced by ID.

- [auth](invariants/auth.md): Accounts, sign-in, sessions, roles, permissions, Organization scoping (server)
- [channels](invariants/channels.md): Channels, membership, Capabilities (server and member UI)
- [messages](invariants/messages.md): Sending, admission, fan-out, removal, delivery, message body and drafts
- [topics](invariants/topics.md): Topics, server and web, incl. their real-time delivery tests
- [replies](invariants/replies.md): Reply chains, server and web, incl. their real-time delivery tests
- [unread](invariants/unread.md): Unread positions and counts, server and web
- [realtime](invariants/realtime.md): WebSocket server: lifecycle, session, notification, access loss, watermark, contract negatives, capacity
- [sync](invariants/sync.md): Web real-time client: protocol, sync controller, Organization sync, shared contract fixtures
- [web](invariants/web.md): Web UI shell: sign-in/session UI, navigation, tokens, timeline, a11y, setup
- [deployment](invariants/deployment.md): Server platform: database, startup, config, shutdown, schema guard, OpenAPI contract
