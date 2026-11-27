use serde_json::{Value, json};
use uuid::Uuid;

pub(crate) fn message(seq: u128, version: u128) -> Value {
    let id = Uuid::from_u128(seq);
    // The base Message omits mentions. Tests that need an empty array add it explicitly.
    json!({
        "history_generation": Uuid::nil(),
        "id": id,
        "channel_id": Uuid::nil(),
        "created_seq": seq,
        "version": version,
        "deleted": false,
        "client_message_id": id,
        "sender": Uuid::nil(),
        "body": "shared body",
        "created_at": "2026-01-01T00:00:00Z",
        "topic_id": null,
        "reply_to": null,
        "reply_root_id": null
    })
}
