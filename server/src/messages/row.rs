use sqlx::{Row, postgres::PgRow};

use super::Message;

// Keep the existing SQL whitespace for each query layout. Callers supply
// mentions and history_generation separately.
macro_rules! message_columns {
    () => {
        message_columns!(@columns "", " ", " ", " ", " ")
    };
    (topic) => {
        message_columns!(@columns "m.", " ", "\n    ", " ", "\n    ")
    };
    (replay) => {
        message_columns!(@columns "m.", "", "", "\n            ", "\n            ")
    };
    (@columns $prefix:literal, $space:literal, $before_sender:literal, $before_reply:literal, $before_timestamp:literal) => {
        concat!(
            $prefix, "id,", $space, $prefix, "channel_id,", $space, $prefix, "seq,", $space,
            $prefix, "version,", $space, $prefix, "deleted,", $space, $prefix, "client_message_id,",
            $before_sender, $prefix, "sender,", $space, $prefix, "body,", $space, $prefix, "topic_id,",
            $before_reply, $prefix, "reply_to_id AS reply_to,", $space, $prefix, "reply_root_id,",
            $before_timestamp, "to_char(", $prefix, "created_at AT TIME ZONE 'UTC',", $space,
            r#"'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at"#
        )
    };
}
pub(super) use message_columns;

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
