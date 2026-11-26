use uuid::Uuid;

use super::receipt::{committed, receipt};
use crate::{
    channels,
    messages::{
        Delivery, Message, MessageError, SendMessageRequest, admission, commit, dm_error,
        guards::check_visibility, history, log, mentions, message_from_row, replies,
        require_visible, search, topics,
    },
};

#[cfg(test)]
mod c3_tests;

#[cfg(test)]
static RECEIPT_MISS: crate::test_support::Gates<Uuid, std::sync::OnceLock<bool>> =
    crate::test_support::Gates::new();

pub(in crate::messages) async fn existing<'e, E: sqlx::PgExecutor<'e>>(
    executor: E,
    organization_id: Uuid,
    sender: Uuid,
    client_message_id: Uuid,
) -> Result<Option<Message>, sqlx::Error> {
    sqlx::query(&mentions::page_sql(
        "SELECT id, channel_id, seq, version, deleted, client_message_id, sender, body, topic_id, reply_to_id AS reply_to, reply_root_id, \
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at \
         FROM messages WHERE organization_id = $1 AND sender = $2 AND client_message_id = $3",
        "p.seq",
    ))
    .bind(organization_id)
    .bind(sender)
    .bind(client_message_id)
    .try_map(|row| message_from_row(&row))
    .fetch_optional(executor)
    .await
}

pub(in crate::messages) async fn persist(
    pool: &sqlx::PgPool,
    delivery: &Delivery,
    organization_id: Uuid,
    sender: (Uuid, i64),
    channel_id: Uuid,
    input: SendMessageRequest,
    waiter: admission::SendWaiter,
) -> Result<Message, MessageError> {
    let _permit = waiter.acquire().await?;
    tokio::time::timeout(
        admission::WORK_TIMEOUT,
        persist_admitted(
            pool,
            delivery,
            organization_id,
            sender,
            channel_id,
            input,
            _permit,
        ),
    )
    .await
    .map_err(|_| {
        tracing::warn!(target: "fukulow", event = "work_deadline_expired", operation = "send");
        MessageError::Database(sqlx::Error::Io(std::io::ErrorKind::TimedOut.into()))
    })?
}

async fn persist_admitted(
    pool: &sqlx::PgPool,
    delivery: &Delivery,
    organization_id: Uuid,
    sender: (Uuid, i64),
    channel_id: Uuid,
    input: SendMessageRequest,
    permit: admission::Permit,
) -> Result<Message, MessageError> {
    let mut tx = commit::Transaction::begin(pool, permit, "BEGIN", Some(organization_id)).await?;
    require_visible(tx.connection()?, organization_id, sender, channel_id).await?;
    let history_generation = history::validate(
        tx.connection()?,
        organization_id,
        channel_id,
        input.history_generation,
        None,
    )
    .await?;
    let member = sender;
    let sender = sender.0;
    if existing(
        tx.connection()?,
        organization_id,
        sender,
        input.client_message_id,
    )
    .await?
    .is_some()
    {
        tx.rollback().await?;
        // Reauthorize and resolve names together in the canonical read snapshot.
        return committed(pool, organization_id, member, channel_id, &input)
            .await?
            .ok_or(MessageError::Database(sqlx::Error::RowNotFound));
    }
    #[cfg(test)]
    let write_probe = if let Some(gate) = RECEIPT_MISS.take(&input.client_message_id) {
        gate.pause().await;
        Some(gate)
    } else {
        None
    };
    let targets = mentions::extract(&input.body);
    let accepted = if let Some((grants, accepted)) = channels::dms::send_locks(
        tx.connection()?,
        organization_id,
        member,
        channel_id,
        &targets,
    )
    .await
    .map_err(dm_error)?
    {
        if input.topic_name.is_some() {
            return Err(MessageError::DmTopicsNotAllowed);
        }
        channels::dms::eligible_peer(tx.connection()?, organization_id, sender, &grants)
            .await
            .map_err(dm_error)?;
        channels::dms::discovery::bump(tx.connection()?, organization_id, channel_id, &grants)
            .await?;
        accepted
    } else {
        let (visible, archived, accepted) = channels::authorize_send_targets(
            tx.connection()?,
            organization_id,
            member,
            channel_id,
            &targets,
        )
        .await?;
        check_visibility(visible)?;
        if archived {
            // Another send can commit before our Channel lock is granted.
            // Resolve its receipt in the locked state before refusing new work.
            let canonical = receipt(
                tx.connection()?,
                organization_id,
                sender,
                channel_id,
                &input,
            )
            .await?;
            tx.rollback().await?;
            return match canonical {
                Some((message, true)) => Ok(message),
                Some((_, false)) => Err(MessageError::Conflict),
                None => Err(MessageError::ChannelArchived),
            };
        }
        accepted
    };
    #[cfg(test)]
    crate::messages::tests::removal::pause(input.client_message_id).await;
    // Read before waiting for the Channel barrier: an uncommitted parent is absent,
    // never a foreign-key wait or an implicitly accepted optimistic client id.
    replies::parent_location(
        tx.connection()?,
        organization_id,
        channel_id,
        input.reply_to,
    )
    .await?;
    #[cfg(test)]
    crate::messages::tests::history::pause(input.client_message_id, "reply_parent").await;
    // Bound every subsequent lock wait, including the counter and idempotency key.
    commit::lock(tx.connection()?, organization_id, channel_id, false).await?;
    // A committed parent may have moved while this Reply waited for the writer.
    let parent = replies::parent_location(
        tx.connection()?,
        organization_id,
        channel_id,
        input.reply_to,
    )
    .await?;
    let seq = log::allocate(tx.connection()?, organization_id, channel_id).await?;
    let topic_id = if let Some((topic, _)) = parent {
        topic
    } else {
        topics::join(
            tx.connection()?,
            organization_id,
            channel_id,
            Some(seq),
            input.topic_name.as_deref(),
        )
        .await?
    };
    let reply_root_id = parent.map(|(_, root)| root);
    let message = sqlx::query(log::CREATE_WITH_MESSAGE_SQL)
        .bind(organization_id)
        .bind(Uuid::new_v4())
        .bind(channel_id)
        .bind(seq)
        .bind(sender)
        .bind(input.client_message_id)
        .bind(&input.body)
        .bind(topic_id)
        .bind(input.reply_to)
        .bind(reply_root_id)
        .bind(history_generation)
        .try_map(|row| message_from_row(&row))
        .fetch_optional(tx.connection()?)
        .await?;
    #[cfg(test)]
    if let Some(gate) = write_probe {
        gate.hook_state.set(message.is_none()).unwrap();
    }
    if let Some(mut message) = message {
        search::SearchEngine::index_send(&mut tx, organization_id, message.id).await?;
        mentions::store(tx.connection()?, organization_id, &mut message, &accepted).await?;
        topics::record(tx.connection()?, organization_id, topic_id, seq).await?;
        let notification = delivery
            .commit_for_publication(
                tx,
                input.client_message_id,
                organization_id,
                channel_id,
                message.created_seq,
            )
            .await?;
        delivery.channel_access.activity.message(
            pool.clone(),
            organization_id,
            channel_id,
            sender,
            message.created_seq,
        );
        notification.spawn(pool.clone(), message.clone());
        return Ok(message);
    }
    tx.rollback().await?;
    // The unique-key conflict implies a committed winner; absence is an invariant failure.
    committed(pool, organization_id, member, channel_id, &input)
        .await?
        .ok_or(MessageError::Database(sqlx::Error::RowNotFound))
}
