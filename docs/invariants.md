# Invariants

Record critical guarantees, cross-cutting rules and denial requirements whose full scope code, tests and `openapi.json` cannot tell. Each Rule must always hold and include its scope and exceptions. Cite its guarding test as `path::test_name`. Add that test with the code and run it in CI. [One home per fact, update by replacement or merge](workflow.md#13-splitting-a-doc).

For each E2E reference, match its file and leaf title as in the static check. Require exactly one matching entry and a final pass in the CI Playwright report (retry pass counts). Static checks remain defence in depth.

File new rows in their main area's part under `docs/invariants/`, one part per area. Read all touched parts. Optional "Rows in other parts" sections are checked. Identify a referenced row by a test name unique to that row in its part. If none is unique, start the Rule cell with `{#id}` (lowercase words and hyphens). Use IDs only for rows referenced by ID.

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
