# Decisions: api

API contract and generated types. [Index and writing rules](../decisions.md)

## API contract
- #301 Cap `POST /api/v1/orgs/{org}/message-authors` at 100 IDs before dedup (400 `ErrorBody` above). Leave omissions unresolved so foreign, unknown and unreadable authors stay indistinguishable.
- `make api` exports without a database. Isolate pinned `openapi-typescript` because its TypeScript 5 peer conflicts with the SPA’s TypeScript 6.
- #23 Message pages accept at most one of `after_seq`/`before_seq` (else latest), ascend by seq and set `has_more` in query direction. REST and shared schema both use 1..=200. REST metadata alone defaults to 50 so shared `ListMessagesQuery` fields stay optional.
- #23 Register serde-tagged WS `oneOf` roots. Name utoipa variants for `type` discriminator refs. Never authenticate WS by query string.
- #17 Cap bodies at 16 KiB, Message sends at 32 KiB (4,000 scalars escape to ~24 KB). `ErrorBody` maps invalid/content type/size to 400/415/413.
- #18 Real upgrade/frame/close tests reuse locked tokio-tungstenite and futures-util as test-only deps. Runtime uses existing serde_json.

- #151 Use ring (already lockfile-pinned through TLS) for AES-256-GCM with domain-separated setup-token key and random nonce to authenticate scope and hide DM discovery positions without custom crypto.

## Entries in other parts

Related entries by prefix.

- [messages](messages.md): `#152 proposes exact`, `#152 Mention counts share`, `#160 Event position and Message`, `#160 Required before any mutation`, `#151 DM is a Channel kind`, `#151 POST /dms opens`, `#151 new sends hold`, `#151 DMs reject Topic intent`, `#299 Channel names are`, `#299 migration validates`, `#204 sections belong`, `#204 composite Organization/Member/section`, `#204 moves, reorders and deletes`, `#311 PATCH /api/v1/orgs/{org}/channels/{id}/members/{member_id}`, `#311 Manager PATCH uses`, `#515 uses Organization UUID epochs`
- [realtime](realtime.md): `#152 Mention counts inherit`, `#151 dm_list_changed targets`, `#151 DM list responses`, `#151 DM list base limits`, `#204 sections_changed goes only`, `#204 section display intersects`
- [process](process.md): `#198 B: pinned tracing/subscriber`, `#195: shutdown also returns 503 for`
- [auth](auth.md): `#151 DM access needs`, `#151 explicit non-Guest open`, `#299 shared raw-text validation`, `#305 Owner may deactivate another active Member`, `#305 owns the deactivation transaction`, `#304 PUT /api/v1/me/password takes`, `#304 wrong current password is 403`, `#303 management follows`, `#303 retains random UUID cursor anchors`
