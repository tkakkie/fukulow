use serde_json::{Value, json};
use uuid::Uuid;

pub(super) fn message(channel_id: Uuid, sender: Uuid, seq: u128, version: u128) -> Value {
    json!({
        "history_generation": Uuid::nil(),
        "id": Uuid::from_u128(seq),
        "channel_id": channel_id,
        "created_seq": seq,
        "version": version,
        "deleted": false,
        "client_message_id": Uuid::from_u128(seq + 1000),
        "sender": sender,
        "body": "body",
        "created_at": "2026-01-01T00:00:00Z",
        "topic_id": null,
        "reply_to": null,
        "reply_root_id": null,
        "mentions": []
    })
}
