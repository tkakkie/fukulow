# Decisions

Writing: only current decisions, what + why in at most 300 characters each; split or link `#n` rather than blur a reason.

Current decisions only: what + why, at most 300 characters each; details in the linked Issue/PR. Superseded entries were removed in #175 and raw measurement records moved to `docs/measurements.md` (#182); the full former text is at [5023c62](https://github.com/tkakkie/fukulow/blob/5023c62a132d4bb986f5e0d14b61d4b0ced31c3e/docs/decisions.md); #178 measurement tables at [2599d3b](https://github.com/tkakkie/fukulow/blob/2599d3b9c0e79f336b5726c6f6fbbc31e5db08da/docs/decisions.md).

Entries live in parts under `docs/decisions/`, one part per area; each entry is in exactly one part, and every other part it governs lists it under "Entries in other parts". Read the parts your change touches (a cross-area change: every related part). A new entry goes in the part of its main area.

- [process](decisions/process.md): Product, stack, delivery, project rules, CI and AI process
- [api](decisions/api.md): API contract and generated types
- [auth](decisions/auth.md): Accounts, sign-in, tenancy, Account Sessions and revocation
- [messages](decisions/messages.md): Channels, Messages, Topics, Replies and Unread
- [realtime](decisions/realtime.md): Real-time delivery, admission, queues and timeouts
- [web](decisions/web.md): Web client
- [load](decisions/load.md): Load testing and measurement rules
