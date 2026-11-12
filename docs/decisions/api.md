# Decisions: api

API contract and generated types. Writing rules and the other parts: [index](../decisions.md).

## API contract
- `make api` exports the contract without a database; `openapi-typescript` is pinned in an isolated npm environment because its TypeScript 5 peer conflicts with the SPA's TypeScript 6.
- #23 published REST and `ClientMessage`/`ServerEvent` types before runtime work. Message pages: `after_seq` XOR `before_seq` (neither = latest), limit 50 default / 200 max, always ascending seq; `has_more` follows the queried direction.
- `ListMessagesQuery` keeps every field optional in the shared schema; the limit default (50) lives only on REST query metadata so generated TypeScript accepts an omitted limit. Both keep min 1 / max 200.
- WebSocket messages are serde-tagged `oneOf` with discriminator `type`, registered as schema roots; utoipa variants are lifted into named components for discriminator references. WebSocket auth never uses a query-string token.
- Request bodies are capped at 16 KiB; only the Message send route allows 32 KiB (a 4,000-scalar body is up to ~24 KB JSON-escaped) (#17). Extraction errors map to `ErrorBody`: 400 invalid, 415 content type, 413 size.
- WebSocket runtime promoted the existing serde_json to a production dependency; test-only tokio-tungstenite and futures-util reuse locked packages to exercise real upgrade/frame/close; no new locked packages (#18).

## Entries in other parts

Entries that also govern this area, listed by the start of the entry in that part.

- [process](process.md): `#195: shutdown also returns 503 for`

- [messages](messages.md): `#311 PATCH /api/v1/orgs/{org}/channels/{id}/members/{member_id}`, `#311 Manager PATCH uses`
