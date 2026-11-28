use crate::{AppState, auth::Auth, channels, database};
use serde::{Deserialize, Serialize};
use sqlx::PgConnection;
use utoipa::ToSchema;
use uuid::Uuid;

#[cfg(test)]
use crate::messages::tests;
use crate::messages::{
    MessageError, admission,
    guards::{check_visibility, reject_dm_topics, reject_dm_topics_scoped, require_visible_scoped},
    history, watermark,
};

mod positions;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ReadPosition {
    pub history_generation: Uuid,
    pub read_seq: i64,
}

pub(super) async fn mark_read(
    state: &AppState,
    auth: &Auth,
    channel: Uuid,
    topic: Option<Uuid>,
    requested_generation: Option<Uuid>,
    requested_seq: i64,
) -> Result<ReadPosition, MessageError> {
    if requested_seq < 0 {
        return Err(MessageError::InvalidInput);
    }
    admission::within_work_deadline(mark_inner(
        state,
        auth,
        channel,
        topic,
        requested_generation,
        requested_seq,
    ))
    .await
}

async fn mark_inner(
    state: &AppState,
    auth: &Auth,
    channel: Uuid,
    topic: Option<Uuid>,
    requested_generation: Option<Uuid>,
    requested_seq: i64,
) -> Result<ReadPosition, MessageError> {
    let organization = auth.identity.organization.organization_id;
    let member = (auth.identity.member.id, auth.membership_revision);
    require_visible_scoped(&state.pool, organization, member, channel).await?;
    if topic.is_some() {
        reject_dm_topics_scoped(state, auth, channel).await?;
    }
    let w = watermark::read(state, organization, channel).await?;
    let state = state.clone();
    let (read_seq, history_generation) = tokio::spawn(async move {
        let (read_seq, changed, history_generation) =
            database::organization(&state.pool, organization, async |tx: &mut PgConnection| {
                set_lock_timeout(tx).await?;
                check_visibility(
                    channels::is_visible_for_write(&mut *tx, organization, member, channel).await?,
                )?;
                let history_generation =
                    history::validate(tx, organization, channel, requested_generation, None)
                        .await?;
                #[cfg(test)]
                tests::removal::pause(member.0).await;
                if topic.is_some() {
                    reject_dm_topics(tx, organization, channel).await?;
                }
                let (read_seq, changed) =
                    advance_position(tx, organization, channel, member, topic, requested_seq, w)
                        .await?;
                Ok::<_, MessageError>((read_seq, changed, history_generation))
            })
            .await?;
        if changed {
            state.message_delivery.channel_access.activity.spawn(
                state.pool.clone(),
                organization,
                channels::activity::Notice::ReadPositionChanged {
                    channel_id: channel,
                    topic_id: topic,
                    read_seq,
                },
                Some(member.0),
                channels::activity::PublicationFence::default(),
            );
        }
        Ok::<_, MessageError>((read_seq, history_generation))
    })
    .await
    .map_err(|_| MessageError::Database(sqlx::Error::WorkerCrashed))??;
    Ok(ReadPosition {
        read_seq,
        history_generation,
    })
}

async fn set_lock_timeout(tx: &mut PgConnection) -> Result<(), sqlx::Error> {
    sqlx::query(database::LOCK_TIMEOUT_SQL).execute(tx).await?;
    Ok(())
}

async fn advance_position(
    tx: &mut PgConnection,
    organization: Uuid,
    channel: Uuid,
    member: (Uuid, i64),
    topic: Option<Uuid>,
    requested: i64,
    w: i64,
) -> Result<(i64, bool), MessageError> {
    // Serialize positions with revocation's cascading delete/reset. If access
    // is lost while waiting, the deleted position itself makes this return 404.
    let initial = positions::lock_channel_position(tx, organization, channel, member).await?;
    let requested = requested.min(w).max(initial);
    let previous =
        positions::previous_position(tx, organization, channel, member.0, topic, initial).await?;
    let read_seq = if let Some(topic) = topic {
        positions::update_topic_position(tx, organization, channel, member.0, topic, requested)
            .await?
    } else {
        positions::update_channel_position(tx, organization, channel, member.0, requested).await?
    };
    Ok((read_seq, read_seq > previous))
}
