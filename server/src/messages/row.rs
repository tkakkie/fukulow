use std::sync::LazyLock;

use sqlx::{Row, postgres::PgRow};

use super::Message;

pub(super) static MESSAGE_COLUMNS: LazyLock<String> =
    LazyLock::new(|| message_columns("", " ", " ", " ", " "));
pub(super) static REPLAY_MESSAGE_COLUMNS: LazyLock<String> =
    LazyLock::new(|| message_columns("m.", "", "", "\n            ", "\n            "));
#[cfg(test)]
pub(super) static TOPIC_MESSAGE_COLUMNS: LazyLock<String> =
    LazyLock::new(|| message_columns("m.", " ", "\n    ", " ", "\n    "));

// Preserve each layout's SQL bytes. The production Topic page keeps its projection
// literal for load/unread-init's source extractor.
fn message_columns(
    prefix: &str,
    space: &str,
    before_sender: &str,
    before_reply: &str,
    before_timestamp: &str,
) -> String {
    format!(
        "{prefix}id,{space}{prefix}channel_id,{space}{prefix}seq,{space}\
        {prefix}version,{space}{prefix}deleted,{space}{prefix}client_message_id,\
        {before_sender}{prefix}sender,{space}{prefix}body,{space}{prefix}topic_id,\
        {before_reply}{prefix}reply_to_id AS reply_to,{space}{prefix}reply_root_id,\
        {before_timestamp}to_char({prefix}created_at AT TIME ZONE 'UTC',{space}'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at"
    )
}

pub(super) fn message_from_row(row: &PgRow) -> Result<Message, sqlx::Error> {
    let deleted: bool = row.try_get("deleted")?;
    let (body, mentions) = if deleted {
        (None, None)
    } else {
        let mentions: String = row.try_get("mentions")?;
        let mentions =
            serde_json::from_str(&mentions).map_err(|error| sqlx::Error::ColumnDecode {
                index: "mentions".into(),
                source: Box::new(error),
            })?;
        (Some(row.try_get("body")?), Some(mentions))
    };
    Ok(Message {
        history_generation: row.try_get("history_generation")?,
        id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        created_seq: row.try_get("seq")?,
        version: row.try_get("version")?,
        deleted,
        client_message_id: row.try_get("client_message_id")?,
        sender: row.try_get("sender")?,
        body,
        created_at: row.try_get("created_at")?,
        topic_id: row.try_get("topic_id")?,
        reply_to: row.try_get("reply_to")?,
        reply_root_id: row.try_get("reply_root_id")?,
        mentions,
    })
}
