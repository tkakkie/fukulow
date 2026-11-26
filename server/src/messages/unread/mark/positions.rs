use sqlx::PgConnection;
use uuid::Uuid;

use crate::messages::MessageError;

pub(super) async fn lock_channel_position(
    tx: &mut PgConnection,
    organization: Uuid,
    channel: Uuid,
    member: (Uuid, i64),
) -> Result<i64, MessageError> {
    sqlx::query_scalar(
        "SELECT initial_seq FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 AND membership_revision=$4 FOR UPDATE",
    )
    .bind(organization)
    .bind(channel)
    .bind(member.0)
    .bind(member.1)
    .fetch_optional(tx)
    .await?
    .ok_or(MessageError::NotFound)
}

pub(super) async fn previous_position(
    tx: &mut PgConnection,
    organization: Uuid,
    channel: Uuid,
    member: Uuid,
    topic: Option<Uuid>,
    initial: i64,
) -> Result<i64, sqlx::Error> {
    if let Some(topic) = topic {
        Ok(sqlx::query_scalar(
            "SELECT read_seq FROM topic_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 AND topic_id=$4",
        )
        .bind(organization)
        .bind(channel)
        .bind(member)
        .bind(topic)
        .fetch_optional(tx)
        .await?
        .unwrap_or(initial))
    } else {
        sqlx::query_scalar(
            "SELECT read_seq FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3",
        )
        .bind(organization)
        .bind(channel)
        .bind(member)
        .fetch_one(tx)
        .await
    }
}

pub(super) async fn update_topic_position(
    tx: &mut PgConnection,
    organization: Uuid,
    channel: Uuid,
    member: Uuid,
    topic: Uuid,
    requested: i64,
) -> Result<i64, MessageError> {
    require_topic(tx, organization, channel, topic).await?;
    // Update first: an upsert would also run the BEFORE INSERT ordinal trigger
    // for the proposed row. Rows are created on access, so the insert is rare.
    let updated = sqlx::query_scalar(
        "UPDATE topic_read_positions SET read_seq=GREATEST(read_seq,$5) WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 AND topic_id=$4 RETURNING read_seq",
    )
    .bind(organization)
    .bind(channel)
    .bind(member)
    .bind(topic)
    .bind(requested)
    .fetch_optional(&mut *tx)
    .await?;
    let read_seq = match updated {
        Some(read_seq) => read_seq,
        None => sqlx::query_scalar(
            "INSERT INTO topic_read_positions (organization_id,channel_id,member_id,topic_id,read_seq) VALUES ($1,$2,$3,$4,$5) \
                    ON CONFLICT (organization_id,channel_id,member_id,topic_id) DO UPDATE SET read_seq=GREATEST(topic_read_positions.read_seq,EXCLUDED.read_seq) RETURNING read_seq")
            .bind(organization)
            .bind(channel)
            .bind(member)
            .bind(topic)
            .bind(requested)
            .fetch_one(tx)
            .await?,
    };
    Ok(read_seq)
}

async fn require_topic(
    tx: &mut PgConnection,
    organization: Uuid,
    channel: Uuid,
    topic: Uuid,
) -> Result<(), MessageError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM topics WHERE organization_id=$1 AND channel_id=$2 AND id=$3)",
    )
    .bind(organization)
    .bind(channel)
    .bind(topic)
    .fetch_one(tx)
    .await?;
    if !exists {
        return Err(MessageError::TopicNotFound);
    }
    Ok(())
}

pub(super) async fn update_channel_position(
    tx: &mut PgConnection,
    organization: Uuid,
    channel: Uuid,
    member: Uuid,
    requested: i64,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "UPDATE channel_read_positions SET read_seq=GREATEST(read_seq,$4) WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 RETURNING read_seq",
    )
    .bind(organization)
    .bind(channel)
    .bind(member)
    .bind(requested)
    .fetch_one(tx)
    .await
}
