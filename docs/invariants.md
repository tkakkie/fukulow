# Invariants

Writing: a Rule cell states what must hold, scope and exceptions included, in at most 160 characters.

Rules that must always hold. Each one lists the test that guards it as `path::test_name`; the test must run in CI. Add the test with the code.

Rows live in parts under `docs/invariants/`, one part per area; each row is in exactly one part, and every other part it touches lists it under "Rows in other parts". Read the parts your change touches (a cross-area change: every related part). A new row goes in the part of its main area; each other area it governs lists it there by a test name that matches only that row, or, when none does, by a `{#id}` (lowercase words and hyphens) added at the start of its Rule cell; an ID is not counted in the Rule limit and is used only where needed.

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
