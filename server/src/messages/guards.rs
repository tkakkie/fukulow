use uuid::Uuid;

use super::MessageError;
use crate::{AppState, auth::Auth, channels};

pub(crate) async fn require_visible_scoped(
    pool: &sqlx::PgPool,
    organization: Uuid,
    member: (Uuid, i64),
    channel: Uuid,
) -> Result<(), MessageError> {
    match channels::is_visible_scoped(pool, organization, member, channel).await? {
        Some(true) => Ok(()),
        Some(false) => Err(MessageError::NotFound),
        None => Err(MessageError::OrganizationUnavailable),
    }
}

pub(crate) async fn require_visible<'e, E: sqlx::PgExecutor<'e>>(
    executor: E,
    organization_id: Uuid,
    member: (Uuid, i64),
    channel_id: Uuid,
) -> Result<(), MessageError> {
    match channels::is_visible(executor, organization_id, member, channel_id).await? {
        Some(true) => Ok(()),
        Some(false) => Err(MessageError::NotFound),
        None => Err(MessageError::OrganizationUnavailable),
    }
}

pub(super) async fn reject_dm_topics(
    connection: &mut sqlx::PgConnection,
    organization: Uuid,
    channel: Uuid,
) -> Result<(), MessageError> {
    if channels::dms::is_dm(connection, organization, channel).await? {
        Err(MessageError::DmTopicsNotAllowed)
    } else {
        Ok(())
    }
}
pub(super) async fn reject_dm_topics_scoped(
    state: &AppState,
    auth: &Auth,
    channel: Uuid,
) -> Result<(), MessageError> {
    let org = auth.identity.organization.organization_id;
    crate::database::organization_read_only(
        &state.pool,
        org,
        async |tx: &mut sqlx::PgConnection| {
            require_visible(
                &mut *tx,
                org,
                (auth.identity.member.id, auth.membership_revision),
                channel,
            )
            .await?;
            reject_dm_topics(tx, org, channel).await
        },
    )
    .await
}
