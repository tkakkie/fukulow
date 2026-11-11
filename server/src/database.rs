use sqlx::{PgPool, migrate::MigrateError};

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
