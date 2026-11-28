use super::acquire;
use sqlx::{PgPool, migrate::MigrateError};

pub(crate) const LOCK_TIMEOUT_SQL: &str = "SET LOCAL lock_timeout = '5s'";

/// `transaction_timeout` (#158) needs PostgreSQL 17; older servers would fail every send.
const MIN_SERVER_VERSION_NUM: i64 = 170_000;

/// Startup and owner-command check: refuses PostgreSQL older than 17.
pub async fn validate_server_version(pool: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
    let mut connection = acquire(pool)
        .await
        .map_err(|_| "Cannot read the PostgreSQL server version")?;
    let version: String = sqlx::query_scalar("SELECT current_setting('server_version_num')")
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| "Cannot read the PostgreSQL server version")?;
    check_server_version(&version).map_err(Into::into)
}

pub(super) fn check_server_version(version: &str) -> Result<(), String> {
    match version.parse::<i64>() {
        Ok(number) if number >= MIN_SERVER_VERSION_NUM => Ok(()),
        _ => Err(format!(
            "PostgreSQL 17 or newer is required (server_version_num {version}, need >= {MIN_SERVER_VERSION_NUM})"
        )),
    }
}

pub enum MigrationFailure {
    Precondition(Box<dyn std::error::Error>),
    Database(&'static str, sqlx::Error),
}

pub async fn migrate_and_grant(pool: &PgPool) -> Result<(), MigrationFailure> {
    validate_server_version(pool)
        .await
        .map_err(MigrationFailure::Precondition)?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fukulow_app')")
            .fetch_one(pool)
            .await
            .map_err(|error| MigrationFailure::Database("migrate_role_lookup", error))?;
    if !exists {
        return Err(MigrationFailure::Precondition(
            "Database role fukulow_app is missing; run `migrate roles` first".into(),
        ));
    }
    migrate(pool).await.map_err(|error| {
        let error = match error {
            MigrateError::Execute(error) | MigrateError::ExecuteMigration(error, _) => error,
            error => sqlx::Error::Migrate(Box::new(error)),
        };
        MigrationFailure::Database("migrate", error)
    })?;
    grants(pool)
        .await
        .map_err(|error| MigrationFailure::Database("migrate_grants", error))
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
    sqlx::query(LOCK_TIMEOUT_SQL)
        .execute(&mut *transaction)
        .await?;
    sqlx::raw_sql(include_str!("../../../deploy/db-grants.sql"))
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await
}

pub async fn roles(pool: &PgPool, password: &str) -> Result<(), Box<dyn std::error::Error>> {
    if password.is_empty() {
        return Err("POSTGRES_APP_PASSWORD must be nonempty".into());
    }
    validate_server_version(pool).await?;
    // Suppress database diagnostics: dynamic utility-statement context can expose
    // the password even though the input is passed as a bound value.
    update_roles(pool, password)
        .await
        .map_err(|_| "Database roles update failed (diagnostics suppressed)".into())
}

async fn update_roles(pool: &PgPool, password: &str) -> Result<(), sqlx::Error> {
    let mut transaction = pool.begin().await?;
    sqlx::query(LOCK_TIMEOUT_SQL)
        .execute(&mut *transaction)
        .await?;
    sqlx::raw_sql(include_str!("../../../deploy/db-role-settings.sql"))
        .execute(&mut *transaction)
        .await?;
    sqlx::query("SELECT set_config('fukulow.app_password', $1, true)")
        .bind(password)
        .execute(&mut *transaction)
        .await?;
    sqlx::raw_sql(include_str!("../../../deploy/db-roles.sql"))
        .execute(&mut *transaction)
        .await?;
    sqlx::raw_sql(include_str!("../../../deploy/db-grants.sql"))
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await
}

pub async fn validate_migrations(pool: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
    validate_server_version(pool).await?;
    // A single read gives a consistent snapshot without SQLx's DDL/lock APIs.
    let applied: Vec<(i64, Vec<u8>, bool)> = sqlx::query_as(
        "SELECT version, checksum, success FROM public._sqlx_migrations ORDER BY version",
    )
    .fetch_all(
        &mut *acquire(pool)
            .await
            .map_err(|_| "Cannot acquire migration history connection")?,
    )
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
