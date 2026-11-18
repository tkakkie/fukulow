# Decisions

Record current decisions and their rationale, including rejected alternatives the code, tests and `openapi.json` cannot explain. Keep one home per fact and replace or merge updates. [Writing rules](workflow.md#13-splitting-a-doc)

Keep each decision on one line and link its Issue or PR for details. Superseded entries were removed in #175 and raw measurement records moved in #182 (see the [measurement summary](measurements.md)); the full former text is at [5023c62](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md); #178 measurement tables at [2599d3b](https://github.com/tkakkie/fukulow/blob/2599d3b9c0e79f336b5726c6f6fbbc31e5db08da/docs/decisions.md).

Entries live in parts under `docs/decisions/`, one part per area. A new entry goes in the part for its main area. "Entries in other parts" sections are optional and checked when present. Read every part your change touches.

- [process](decisions/process.md): Product, stack, delivery, project rules, CI and AI process
- [api](decisions/api.md): API contract and generated types
- [auth](decisions/auth.md): Accounts, sign-in, tenancy, Account Sessions and revocation
- [messages](decisions/messages.md): Channels, Messages, Topics, Replies and Unread
- [realtime](decisions/realtime.md): Real-time delivery, admission, queues and timeouts
- [web](decisions/web.md): Web client
- [load](decisions/load.md): Load testing and measurement rules
