use sqlx::{PgConnection, PgPool, Postgres, migrate::MigrateError, pool::PoolConnection};

mod context;
mod pool;
pub(crate) use context::organization_read_only_detached;
pub(crate) use context::set_organization;
pub use context::{account, account_read_only, organization, organization_read_only};
pub(crate) use context::{organization_statement, organization_statement_sql};
pub use pool::PoolConfig;

pub(crate) const READY_ACQUIRE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(200);
pub(crate) const READY_QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(200);
pub(crate) const READY_RETURN_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(200);

pub(crate) async fn ready(pool: &PgPool) -> bool {
    let Ok(Ok(connection)) = tokio::time::timeout(READY_ACQUIRE_TIMEOUT, pool.acquire()).await
    else {
        return false;
    };
    let mut guard = ReadyConnection(Some(connection));
    let Some(connection) = guard.0.as_mut() else {
        return false;
    };
    if !matches!(
        tokio::time::timeout(
            READY_QUERY_TIMEOUT,
            sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&mut **connection),
        )
        .await,
        Ok(Ok(1))
    ) {
        return false;
    }
    let Some(mut connection) = guard.0.take() else {
        return false;
    };
    // SQLx moves the socket and pool permit into this future synchronously.
    // Dropping it on timeout/cancellation closes the socket and frees the permit;
    // PoolConnection::Drop would instead spawn an unbounded return ping.
    tokio::time::timeout(READY_RETURN_TIMEOUT, connection.return_to_pool())
        .await
        .is_ok()
}

struct ReadyConnection(Option<PoolConnection<Postgres>>);

impl Drop for ReadyConnection {
    fn drop(&mut self) {
        if let Some(connection) = self.0.take() {
            // Includes errors and cancellation while SELECT 1 is in flight.
            drop(connection.detach());
        }
    }
}

pub async fn read_only<T, E>(
    pool: &PgPool,
    body: impl AsyncFnOnce(&mut PgConnection) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<sqlx::Error>,
{
    transaction(pool, true, Discard::Close, body).await
}

enum Discard {
    Close,
    Detach,
}

async fn transaction<T, E>(
    pool: &PgPool,
    read_only: bool,
    discard: Discard,
    body: impl AsyncFnOnce(&mut PgConnection) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<sqlx::Error>,
{
    let mut guard = TransactionConnection {
        connection: None,
        finished: false,
        discard,
    };
    let connection = guard.connection.insert(pool.acquire().await?);
    // SQLx 0.8.6 records transaction depth only after BEGIN's response, so its
    // rollback-on-drop cannot recover a BEGIN cancelled before that response.
    sqlx::Executor::execute(
        &mut **connection,
        if read_only {
            "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
        } else {
            "BEGIN"
        },
    )
    .await?;
    let result = body(connection).await;
    // Read snapshots always roll back; writes commit only a successful body.
    let end = if !read_only && result.is_ok() {
        "COMMIT"
    } else {
        "ROLLBACK"
    };
    let finished = sqlx::Executor::execute(&mut **connection, end).await;
    guard.finished = finished.is_ok();
    // A body error (e.g. 404) outranks a cleanup failure; the armed guard still discards.
    let value = result?;
    finished?;
    Ok(value)
}

struct TransactionConnection {
    connection: Option<PoolConnection<Postgres>>,
    finished: bool,
    discard: Discard,
}

impl Drop for TransactionConnection {
    fn drop(&mut self) {
        if !self.finished
            && let Some(mut connection) = self.connection.take()
        {
            match self.discard {
                Discard::Close => connection.close_on_drop(),
                // SQLx graceful close can retain the permit for five seconds.
                // Deadline-bound workers must free it synchronously instead.
                Discard::Detach => drop(connection.detach()),
            }
        }
    }
}

pub async fn migrate_and_grant(pool: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fukulow_app')")
            .fetch_one(pool)
            .await
            .map_err(|_| "Database migration failed (diagnostics suppressed)")?;
    if !exists {
        return Err("Database role fukulow_app is missing; run `migrate roles` first".into());
    }
    migrate(pool)
        .await
        .map_err(|_| "Database migration failed (diagnostics suppressed)")?;
    grants(pool)
        .await
        .map_err(|_| "Database migration failed (diagnostics suppressed)")?;
    Ok(())
}

pub async fn migrate(pool: &PgPool) -> Result<(), MigrateError> {
    let mut connection = pool.acquire().await?;
    // Migrations may run longer than ordinary queries; discard their session
    // settings and advisory lock on every exit, including failure/cancellation.
    connection.close_on_drop();
    sqlx::raw_sql(
        "SET statement_timeout = 0; SET transaction_timeout = 0; SET lock_timeout = '5s'",
    )
    .execute(&mut *connection)
    .await?;
    sqlx::migrate!().run(&mut *connection).await
}

pub async fn grants(pool: &PgPool) -> Result<(), sqlx::Error> {
    let mut transaction = pool.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '5s'")
        .execute(&mut *transaction)
        .await?;
    sqlx::raw_sql(include_str!("../../deploy/db-grants.sql"))
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await
}

pub async fn roles(pool: &PgPool, password: &str) -> Result<(), Box<dyn std::error::Error>> {
    if password.is_empty() {
        return Err("POSTGRES_APP_PASSWORD must be nonempty".into());
    }
    // Suppress database diagnostics: dynamic utility-statement context can expose
    // the password even though the input is passed as a bound value.
    update_roles(pool, password)
        .await
        .map_err(|_| "Database roles update failed (diagnostics suppressed)".into())
}

async fn update_roles(pool: &PgPool, password: &str) -> Result<(), sqlx::Error> {
    let mut transaction = pool.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '5s'")
        .execute(&mut *transaction)
        .await?;
    sqlx::raw_sql(include_str!("../../deploy/db-role-settings.sql"))
        .execute(&mut *transaction)
        .await?;
    sqlx::query("SELECT set_config('fukulow.app_password', $1, true)")
        .bind(password)
        .execute(&mut *transaction)
        .await?;
    sqlx::raw_sql(include_str!("../../deploy/db-roles.sql"))
        .execute(&mut *transaction)
        .await?;
    sqlx::raw_sql(include_str!("../../deploy/db-grants.sql"))
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await
}

pub async fn validate_migrations(pool: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
    // A single read gives a consistent snapshot without SQLx's DDL/lock APIs.
    let applied: Vec<(i64, Vec<u8>, bool)> = sqlx::query_as(
        "SELECT version, checksum, success FROM public._sqlx_migrations ORDER BY version",
    )
    .fetch_all(pool)
    .await
    .map_err(|_| "Cannot read migration history; run the matching migrate command first")?;
    let migrations = sqlx::migrate!();
    if applied.len() != migrations.iter().count()
        || applied
            .iter()
            .zip(migrations.iter())
            .any(|((version, checksum, success), expected)| {
                !success || *version != expected.version || checksum != expected.checksum.as_ref()
            })
    {
        return Err("Database migration version/checksum/state mismatch; run matching migrations before starting the app".into());
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests;
