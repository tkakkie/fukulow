use super::{
    MessageError,
    guards::{check_visibility, require_visible, require_visible_scoped},
    watermark,
};
use crate::{AppState, auth::Auth};
use sqlx::PgConnection;
use uuid::Uuid;

/// Check visibility before returning the pending history snapshot read.
/// Callers can run pre-admission checks or apply a work deadline before polling it.
pub(super) async fn prepare_snapshot<T>(
    state: &AppState,
    auth: &Auth,
    channel: Uuid,
    requested: Option<Uuid>,
    fixed_w: Option<i64>,
    before_page: impl AsyncFnOnce(&mut PgConnection) -> Result<(), MessageError>,
    body: impl AsyncFnOnce(&mut PgConnection, Uuid, i64) -> Result<T, MessageError>,
) -> Result<impl Future<Output = Result<T, MessageError>>, MessageError> {
    let organization = auth.identity.organization.organization_id;
    let member = (auth.identity.member.id, auth.membership_revision);
    require_visible_scoped(&state.pool, organization, member, channel).await?;

    Ok(async move {
        watermark::read(state, organization, channel).await?;
        crate::database::organization_read_only(
            &state.pool,
            organization,
            async |tx: &mut PgConnection| {
                require_visible(&mut *tx, organization, member, channel).await?;
                before_page(tx).await?;
                let (generation, w) = page(tx, organization, channel, requested, fixed_w).await?;
                body(tx, generation, w).await
            },
        )
        .await
    })
}

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
    check_visibility(visible)?;
    let generation = generation.ok_or(sqlx::Error::RowNotFound)?;
    if expected.is_some_and(|old| old != generation) {
        return Err(MessageError::HistoryGenerationChanged);
    }
    Ok(generation)
}
