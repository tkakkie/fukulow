use super::{migrate, validate_migrations};
use sqlx::{
    PgPool,
    migrate::{Migrate, MigrateError},
    postgres::PgPoolOptions,
};
use std::time::{Duration, Instant};

pub(crate) mod context;
pub(crate) mod interrupted;
mod read_only;
mod rls;
mod statement;

async fn startup_pool(pool: &PgPool) -> PgPool {
    PgPoolOptions::new()
        .max_connections(1)
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap()
}

#[fukulow_test::test(migrations = false)]
async fn application_requires_migration_history_without_creating_it(pool: PgPool) {
    assert!(validate_migrations(&pool).await.is_err());
    let history: Option<String> =
        sqlx::query_scalar("SELECT to_regclass('public._sqlx_migrations')::text")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(history, None);
}

#[fukulow_test::test]
async fn application_rejects_migration_version_checksum_failed_missing_and_extra_rows(
    pool: PgPool,
) {
    validate_migrations(&pool).await.unwrap();
    let version = sqlx::migrate!().iter().last().unwrap().version;
    let checksum: Vec<u8> =
        sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = $1")
            .bind(version)
            .fetch_one(&pool)
            .await
            .unwrap();
    for (change, revert) in [
        (
            "UPDATE _sqlx_migrations SET version = version + 1 WHERE version = $1",
            "UPDATE _sqlx_migrations SET version = version - 1 WHERE version = $1 + 1",
        ),
        (
            "UPDATE _sqlx_migrations SET checksum = decode('00', 'hex') WHERE version = $1",
            "UPDATE _sqlx_migrations SET checksum = $2 WHERE version = $1",
        ),
        (
            "UPDATE _sqlx_migrations SET success = false WHERE version = $1",
            "UPDATE _sqlx_migrations SET success = true WHERE version = $1",
        ),
    ] {
        sqlx::query(change)
            .bind(version)
            .execute(&pool)
            .await
            .unwrap();
        assert!(validate_migrations(&pool).await.is_err(), "{change}");
        let mut query = sqlx::query(revert).bind(version);
        if revert.contains("$2") {
            query = query.bind(&checksum);
        }
        query.execute(&pool).await.unwrap();
        validate_migrations(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES ($1 + 1, 'extra', true, $2, 0)")
            .bind(version).bind(&checksum).execute(&pool).await.unwrap();
    assert!(validate_migrations(&pool).await.is_err());
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version >= $1")
        .bind(version)
        .execute(&pool)
        .await
        .unwrap();
    assert!(validate_migrations(&pool).await.is_err());
}

async fn lock_timeout(pool: &PgPool) -> String {
    sqlx::query_scalar("SHOW lock_timeout")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[fukulow_test::test(migrations = false)]
async fn startup_migrations_succeed_and_keep_timeout_out_of_application_pool(pool: PgPool) {
    let pool = startup_pool(&pool).await;
    let original_timeout = lock_timeout(&pool).await;
    for _ in 0..2 {
        migrate(&pool).await.unwrap();
        assert_eq!(lock_timeout(&pool).await, original_timeout);
    }
    let applied: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations WHERE success")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(applied, sqlx::migrate!().iter().count() as i64);
    pool.close().await;
}

#[fukulow_test::test(migrations = false)]
async fn startup_migrations_timeout_on_advisory_lock_and_can_retry(pool: PgPool) {
    let startup = startup_pool(&pool).await;
    let original_timeout = lock_timeout(&startup).await;
    let mut holder = pool.acquire().await.unwrap();
    holder.close_on_drop();
    // Use SQLx's own lock API so the holder and startup use the same lock key.
    holder.lock().await.unwrap();

    let started = Instant::now();
    let error = tokio::time::timeout(Duration::from_secs(15), migrate(&startup))
        .await
        .expect("startup migration must not wait indefinitely for the advisory lock")
        .unwrap_err();
    assert!(started.elapsed() >= Duration::from_secs(4));
    match error {
        MigrateError::Execute(error) => assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("55P03")
        ),
        error => panic!("expected advisory lock timeout, got {error:?}"),
    }
    assert_eq!(lock_timeout(&startup).await, original_timeout);
    let history: Option<String> =
        sqlx::query_scalar("SELECT to_regclass('public._sqlx_migrations')::text")
            .fetch_one(&startup)
            .await
            .unwrap();
    assert_eq!(history, None);

    holder.unlock().await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), migrate(&startup))
        .await
        .expect("startup migration must succeed after releasing the advisory lock")
        .unwrap();
    assert_eq!(lock_timeout(&startup).await, original_timeout);
    let applied: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations WHERE success")
        .fetch_one(&startup)
        .await
        .unwrap();
    assert_eq!(applied, sqlx::migrate!().iter().count() as i64);
    startup.close().await;
}

#[fukulow_test::test(migrations = false)]
async fn startup_migrations_timeout_on_ddl_lock_and_can_retry_without_partial_changes(
    pool: PgPool,
) {
    let mut initial = sqlx::migrate!();
    initial
        .migrations
        .to_mut()
        .retain(|migration| migration.version < 202611090075);
    initial.run(&pool).await.unwrap();
    let startup = startup_pool(&pool).await;
    let original_timeout = lock_timeout(&startup).await;
    let mut reader = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE sessions IN ACCESS SHARE MODE")
        .execute(&mut *reader)
        .await
        .unwrap();

    let started = Instant::now();
    let error = tokio::time::timeout(Duration::from_secs(15), migrate(&startup))
        .await
        .expect("startup migration must not wait indefinitely for a DDL lock")
        .unwrap_err();
    assert!(started.elapsed() >= Duration::from_secs(4));
    match error {
        MigrateError::ExecuteMigration(error, version) => {
            assert_eq!(version, 202611090075);
            assert_eq!(
                error.as_database_error().unwrap().code().as_deref(),
                Some("55P03")
            );
        }
        error => panic!("expected migration lock timeout, got {error:?}"),
    }
    assert_eq!(lock_timeout(&startup).await, original_timeout);
    let unchanged: (bool, i64) = sqlx::query_as(
        "SELECT to_regclass('public.sessions_expiry') IS NOT NULL, \
             (SELECT count(*) FROM _sqlx_migrations WHERE version = 202611090075)",
    )
    .fetch_one(&startup)
    .await
    .unwrap();
    assert_eq!(unchanged, (true, 0));

    reader.rollback().await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), migrate(&startup))
        .await
        .expect("failed migration must release its advisory lock for retry")
        .unwrap();
    assert_eq!(lock_timeout(&startup).await, original_timeout);
    let applied: (bool, bool) = sqlx::query_as(
        "SELECT to_regclass('public.sessions_expiry') IS NULL, \
             (SELECT success FROM _sqlx_migrations WHERE version = 202611090075)",
    )
    .fetch_one(&startup)
    .await
    .unwrap();
    assert_eq!(applied, (true, true));
    startup.close().await;
}
