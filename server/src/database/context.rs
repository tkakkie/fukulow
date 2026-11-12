use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

/// One autocommit SELECT, with $1 bound as the Organization UUID. The local
/// setting ends with the statement's implicit transaction. The materialized
/// context must produce a row before the correlated LATERAL read can run;
/// OFFSET 0 prevents flattening away that dependency (a bare CROSS JOIN does not).
/// Callers must consume the complete result, issue no other SQL, and preserve
/// ORDER BY at the outermost level when row order matters. Multi-statement reads
/// must use organization_read_only instead. Errors/cancellation discard the
/// connection rather than trusting an unconfirmed ReadyForQuery/implicit COMMIT.
pub(crate) async fn organization_statement<T>(
    pool: &PgPool,
    sql: &str,
    body: impl AsyncFnOnce(&mut PgConnection, &str) -> Result<T, sqlx::Error>,
) -> Result<T, sqlx::Error> {
    let sql = organization_statement_sql(sql);
    let mut guard = super::TransactionConnection {
        connection: Some(pool.acquire().await?),
        finished: false,
        discard: super::Discard::Detach,
    };
    let result = body(
        guard
            .connection
            .as_deref_mut()
            .ok_or(sqlx::Error::WorkerCrashed)?,
        &sql,
    )
    .await?;
    guard.finished = true;
    Ok(result)
}

/// Also usable inside an owned explicit transaction (e.g. the COMMIT barrier).
/// $1 must be a UUID; all data parameters remain bound by the caller.
pub(crate) fn organization_statement_sql(sql: &str) -> String {
    format!(
        "WITH fukulow_context AS MATERIALIZED (\
         SELECT set_config('fukulow.organization_id', $1::uuid::text, true) AS id) \
         SELECT data.* FROM fukulow_context CROSS JOIN LATERAL (\
         SELECT * FROM ({sql}) scoped WHERE fukulow_context.id IS NOT NULL OFFSET 0) data"
    )
}

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
