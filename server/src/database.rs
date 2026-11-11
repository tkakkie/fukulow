use sqlx::{PgConnection, PgPool, Postgres, migrate::MigrateError, pool::PoolConnection};

pub async fn read_only<T, E>(
    pool: &PgPool,
    body: impl AsyncFnOnce(&mut PgConnection) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<sqlx::Error>,
{
    let mut guard = ReadOnlyConnection {
        connection: pool.acquire().await?,
        finished: false,
    };
    // SQLx 0.8.6 records transaction depth only after BEGIN's response, so its
    // rollback-on-drop cannot recover a BEGIN cancelled before that response.
    sqlx::Executor::execute(
        &mut *guard.connection,
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    )
    .await?;
    let result = body(&mut guard.connection).await;
    // End the snapshot even on ordinary body errors; only incomplete work is discarded.
    let rolled_back = sqlx::Executor::execute(&mut *guard.connection, "ROLLBACK").await;
    guard.finished = rolled_back.is_ok();
    // A body error (e.g. 404) outranks a cleanup failure; the armed guard still discards.
    let value = result?;
    rolled_back?;
    Ok(value)
}

struct ReadOnlyConnection {
    connection: PoolConnection<Postgres>,
    finished: bool,
}

impl Drop for ReadOnlyConnection {
    fn drop(&mut self) {
        if !self.finished {
            self.connection.close_on_drop();
        }
    }
}

pub async fn migrate_and_grant(pool: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fukulow_app')")
            .fetch_one(pool)
            .await?;
    if !exists {
        return Err("Database role fukulow_app is missing; run `migrate roles` first".into());
    }
    migrate(pool).await?;
    grants(pool).await?;
    Ok(())
}

pub async fn migrate(pool: &PgPool) -> Result<(), MigrateError> {
    let mut connection = pool.acquire().await?;
    // Discard the migration-only timeout and advisory lock on every exit.
    connection.close_on_drop();
    sqlx::query("SET lock_timeout = '5s'")
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
mod tests;
