use super::MessageError;
use sqlx::PgConnection;
use uuid::Uuid;

/// The commit barrier must complete before opening this snapshot. Choose W here,
/// alongside M and the mutable rows, rather than using the barrier's older W.
pub(super) async fn page(
    tx: &mut PgConnection,
    organization: Uuid,
    channel: Uuid,
    requested: Option<Uuid>,
    fixed_w: Option<i64>,
) -> Result<(Uuid, i64), MessageError> {
    let generation = validate(tx, organization, channel, requested, None).await?;
    let (latest, floor) = sqlx::query_as::<_, (i64, i64)>(
        "SELECT seq, mutation_seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2",
    ).bind(organization).bind(channel).fetch_optional(tx).await?.unwrap_or((0, 0));
    let w = fixed_w.unwrap_or(latest);
    if w < floor {
        return Err(MessageError::SnapshotExpired);
    }
    if w > latest {
        return Err(MessageError::InvalidInput);
    }
    #[cfg(test)]
    super::tests::history::pause(channel, "snapshot").await;
    Ok((generation, w))
}

/// Call after authorization in the same fresh snapshot as the page data.
pub(crate) async fn validate(
    tx: &mut PgConnection,
    organization: Uuid,
    channel: Uuid,
    requested: Option<Uuid>,
    fixed_w: Option<i64>,
) -> Result<Uuid, MessageError> {
    let generation = crate::auth::history::generation(tx, organization).await?;
    if requested.is_some_and(|requested| requested != generation) {
        return Err(MessageError::HistoryGenerationChanged);
    }
    if fixed_w.is_none() {
        return Ok(generation);
    }
    let floor: Option<i64> = sqlx::query_scalar(
        "SELECT mutation_seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2",
    ).bind(organization).bind(channel).fetch_optional(tx).await?;
    if fixed_w.is_some_and(|w| w < floor.unwrap_or(0)) {
        return Err(MessageError::SnapshotExpired);
    }
    Ok(generation)
}

/// Single-statement subscription authorization and epoch snapshot, preserving #314's hot path.
pub(crate) async fn authorized_generation(
    pool: &sqlx::PgPool,
    organization: Uuid,
    member: (Uuid, i64),
    channel: Uuid,
    expected: Option<Uuid>,
) -> Result<Uuid, MessageError> {
    let sql = format!(
        "SELECT ({}) AS visible, ({}) AS history_generation",
        crate::channels::member_visibility_sql(false),
        crate::auth::history::GENERATION_SQL
    );
    let (visible, generation): (Option<bool>, Option<Uuid>) =
        crate::database::organization_statement(
            pool,
            &sql,
            async |tx: &mut PgConnection, sql: &str| {
                sqlx::query_as(sql)
                    .bind(organization)
                    .bind(member.0)
                    .bind(member.1)
                    .bind(channel)
                    .fetch_one(tx)
                    .await
            },
        )
        .await?;
    match visible {
        None => return Err(MessageError::OrganizationUnavailable),
        Some(false) => return Err(MessageError::NotFound),
        Some(true) => {}
    }
    let generation = generation.ok_or(sqlx::Error::RowNotFound)?;
    if expected.is_some_and(|old| old != generation) {
        return Err(MessageError::HistoryGenerationChanged);
    }
    Ok(generation)
}
