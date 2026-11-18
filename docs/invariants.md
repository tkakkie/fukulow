# Invariants

State critical guarantees, cross-cutting rules and denial requirements whose full scope the code, tests and `openapi.json` cannot tell. A Rule cell includes its scope and exceptions. Keep one home per fact and replace or merge updates. [Writing rules](workflow.md#13-splitting-a-doc)

Rules that must always hold. Each one lists the test that guards it as `path::test_name`; the test must run in CI. Add the test with the code.
E2E rows require a final pass in the CI Playwright report (a pass after retry counts); static checks remain defence in depth. E2E names use the file and leaf title, as in the static check; multiple report entries with that identity are refused.

Rows live in parts under `docs/invariants/`, one part per area. A new row goes in the part for its main area. Read every part your change touches. "Rows in other parts" sections are optional and checked when present. Cite a test name unique to the row in its part, or add a `{#id}` (lowercase words and hyphens) at the start of the Rule cell if no test name is unique. Use IDs only for rows referenced by ID.

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
