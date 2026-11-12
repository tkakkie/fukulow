use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

/// Commit successful work; roll back body errors. Context never outlives the transaction.
pub async fn organization<T, E>(
    pool: &PgPool,
    organization: Uuid,
    body: impl AsyncFnOnce(&mut PgConnection) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<sqlx::Error>,
{
    with_context(pool, organization, false, true, super::Discard::Close, body).await
}

/// A REPEATABLE READ, READ ONLY snapshot with Organization context.
pub async fn organization_read_only<T, E>(
    pool: &PgPool,
    organization: Uuid,
    body: impl AsyncFnOnce(&mut PgConnection) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<sqlx::Error>,
{
    with_context(pool, organization, true, true, super::Discard::Close, body).await
}

/// Deadline-bound snapshot: unconfirmed cleanup frees the pool slot synchronously.
pub(crate) async fn organization_read_only_detached<T, E>(
    pool: &PgPool,
    organization: Uuid,
    body: impl AsyncFnOnce(&mut PgConnection) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<sqlx::Error>,
{
    with_context(pool, organization, true, true, super::Discard::Detach, body).await
}

/// Account-only work, without granting an Organization context.
pub async fn account<T, E>(
    pool: &PgPool,
    account: Uuid,
    body: impl AsyncFnOnce(&mut PgConnection) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<sqlx::Error>,
{
    with_context(pool, account, false, false, super::Discard::Close, body).await
}

/// A REPEATABLE READ, READ ONLY snapshot for Account-only reads.
pub async fn account_read_only<T, E>(
    pool: &PgPool,
    account: Uuid,
    body: impl AsyncFnOnce(&mut PgConnection) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<sqlx::Error>,
{
    with_context(pool, account, true, false, super::Discard::Close, body).await
}

async fn with_context<T, E>(
    pool: &PgPool,
    id: Uuid,
    read_only: bool,
    organization: bool,
    discard: super::Discard,
    body: impl AsyncFnOnce(&mut PgConnection) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<sqlx::Error>,
{
    super::transaction(
        pool,
        read_only,
        discard,
        async |connection: &mut PgConnection| {
            if organization {
                set_organization(connection, id).await?;
            } else {
                sqlx::query("SELECT set_config('fukulow.account_id', $1, true)")
                    .bind(id.to_string())
                    .execute(&mut *connection)
                    .await?;
            }
            body(connection).await
        },
    )
    .await
}

pub(crate) async fn set_organization(
    connection: &mut PgConnection,
    organization: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT set_config('fukulow.organization_id', $1, true)")
        .bind(organization.to_string())
        .execute(connection)
        .await?;
    Ok(())
}
