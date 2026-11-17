use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

pub(crate) const GENERATION_SQL: &str =
    "SELECT history_generation FROM organizations WHERE organization_id=$1";

pub(crate) async fn generation(
    tx: &mut PgConnection,
    organization: Uuid,
) -> Result<Uuid, sqlx::Error> {
    sqlx::query_scalar(GENERATION_SQL)
        .bind(organization)
        .fetch_one(tx)
        .await
}

pub(crate) async fn validate(
    tx: &mut PgConnection,
    organization: Uuid,
    expected: Option<Uuid>,
) -> Result<Uuid, super::ApiError> {
    let generation = generation(tx, organization).await?;
    if expected.is_some_and(|old| old != generation) {
        return Err(super::ApiError(
            axum::http::StatusCode::CONFLICT,
            "history_generation_changed",
            None,
        ));
    }
    Ok(generation)
}

/// Owner-only operator command. None is the documented global restore operation.
/// Bound lock/work waits; rotate all selected Organizations atomically.
pub async fn rotate(pool: &PgPool, organization: Option<Uuid>) -> Result<u64, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL lock_timeout='5s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='10s'")
        .execute(&mut *tx)
        .await?;
    let count = sqlx::query("UPDATE organizations SET history_generation=gen_random_uuid() WHERE $1::uuid IS NULL OR organization_id=$1")
        .bind(organization).execute(&mut *tx).await?.rows_affected();
    if organization.is_some() && count != 1 {
        return Err(sqlx::Error::RowNotFound);
    }
    tx.commit().await?;
    Ok(count)
}
