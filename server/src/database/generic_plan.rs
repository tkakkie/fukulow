use sqlx::{PgConnection, PgPool};

// READ COMMITTED: the one statement takes its snapshot at execution, as the
// autocommit path did. REPEATABLE READ would fix it at Parse, a separate round
// trip on a statement-cache miss, so a revocation committed in between would
// still authorize the page.
pub(super) const BEGIN: &str = "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY; \
     SET LOCAL plan_cache_mode = force_generic_plan";

/// `organization_statement` for a statement that PostgreSQL would re-plan on
/// every execution although planning dominates its run time (#515). One
/// read-only statement snapshot with a transaction-local generic plan: BEGIN and
/// SET LOCAL share one simple-query round trip, and the setting ends with the
/// ROLLBACK.
/// Errors before a confirmed ROLLBACK, and cancellation, discard the connection.
pub(crate) async fn organization_statement_generic<T>(
    pool: &PgPool,
    sql: &str,
    body: impl AsyncFnOnce(&mut PgConnection, &str) -> Result<T, sqlx::Error>,
) -> Result<T, sqlx::Error> {
    let sql = super::organization_statement_sql(sql);
    let mut guard = super::TransactionConnection::new(super::Discard::Detach);
    let connection = guard.connection.insert(super::acquire(pool).await?);
    sqlx::Executor::execute(&mut **connection, BEGIN).await?;
    let result = body(connection, &sql).await;
    let finished = sqlx::Executor::execute(&mut **connection, "ROLLBACK").await;
    guard.finished = finished.is_ok();
    let value = result?;
    finished?;
    Ok(value)
}
