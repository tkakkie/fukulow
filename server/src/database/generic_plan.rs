use sqlx::{PgConnection, PgPool};

pub(super) const BEGIN: &str = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; \
     SET LOCAL plan_cache_mode = force_generic_plan";

/// `organization_statement` for a statement that PostgreSQL would re-plan on
/// every execution although planning dominates its run time (#515). One
/// read-only snapshot with a transaction-local generic plan: BEGIN and SET LOCAL
/// share one simple-query round trip, and the setting ends with the ROLLBACK.
/// Errors before a confirmed ROLLBACK, and cancellation, discard the connection.
pub(crate) async fn organization_statement_generic<T>(
    pool: &PgPool,
    sql: &str,
    body: impl AsyncFnOnce(&mut PgConnection, &str) -> Result<T, sqlx::Error>,
) -> Result<T, sqlx::Error> {
    let sql = super::organization_statement_sql(sql);
    let mut guard = super::TransactionConnection {
        connection: Some(super::acquire(pool).await?),
        finished: false,
        discard: super::Discard::Detach,
    };
    let connection = guard
        .connection
        .as_deref_mut()
        .ok_or(sqlx::Error::WorkerCrashed)?;
    sqlx::Executor::execute(&mut *connection, BEGIN).await?;
    let result = body(&mut *connection, &sql).await;
    let finished = sqlx::Executor::execute(&mut *connection, "ROLLBACK").await;
    guard.finished = finished.is_ok();
    let value = result?;
    finished?;
    Ok(value)
}
