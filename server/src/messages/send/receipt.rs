use std::sync::LazyLock;

use uuid::Uuid;

use crate::{
    channels,
    messages::{
        Message, MessageError, SendMessageRequest, history, mentions, message_from_row,
        row::MESSAGE_COLUMNS,
    },
};

/// The canonical Message for a committed `client_message_id`, or 409 for changed intent.
/// Access is rechecked first: a retry after access loss is denied, never answered.
/// Intent is compared with the receipt fixed at creation, never with current state,
/// and the answer is the Message's current state.
pub(in crate::messages) async fn committed(
    pool: &sqlx::PgPool,
    organization_id: Uuid,
    sender: (Uuid, i64),
    channel_id: Uuid,
    input: &SendMessageRequest,
) -> Result<Option<Message>, MessageError> {
    crate::database::organization_read_only(
        pool,
        organization_id,
        async |tx: &mut sqlx::PgConnection| {
            let archived = channels::visible_archive_state(tx, organization_id, sender, channel_id)
                .await?
                .ok_or(MessageError::OrganizationUnavailable)?
                .ok_or(MessageError::NotFound)?;
            if input.history_generation.is_some() {
                history::validate(
                    tx,
                    organization_id,
                    channel_id,
                    input.history_generation,
                    None,
                )
                .await?;
            }
            // The receipt query supplies the generation for a canonical retry.
            match receipt(&mut *tx, organization_id, sender.0, channel_id, input).await? {
                Some((message, true)) => Ok(Some(message)),
                Some((_, false)) => Err(MessageError::Conflict),
                None if archived => Err(MessageError::ChannelArchived),
                None => Ok(None),
            }
        },
    )
    .await
}

/// The committed Message for this send key and whether the request matches its
/// original-send receipt (S5). Topic intent is normalized in SQL exactly as
/// Topics derive `name_key`; a Reply carries none.
pub(super) async fn receipt<'e, E: sqlx::PgExecutor<'e>>(
    executor: E,
    organization_id: Uuid,
    sender: Uuid,
    channel_id: Uuid,
    input: &SendMessageRequest,
) -> Result<Option<(Message, bool)>, sqlx::Error> {
    use sqlx::Row;
    static SQL: LazyLock<String> = LazyLock::new(|| {
        mentions::page_sql(
            &format!(
                "SELECT {}, send_digest = fukulow_send_digest($4, $5, lower($6 COLLATE \"C\"), $7) AS same_intent \
                 FROM messages WHERE organization_id = $1 AND sender = $2 AND client_message_id = $3",
                MESSAGE_COLUMNS.as_str(),
            ),
            "p.seq",
        )
    });
    sqlx::query(SQL.as_str())
        .bind(organization_id)
        .bind(sender)
        .bind(input.client_message_id)
        .bind(channel_id)
        .bind(&input.body)
        .bind(input.topic_name.as_deref())
        .bind(input.reply_to)
        .try_map(|row| Ok((message_from_row(&row)?, row.try_get("same_intent")?)))
        .fetch_optional(executor)
        .await
}
