use super::{migrate, startup_pool, timeouts, validate_migrations};
use sqlx::{PgPool, Postgres, Transaction};
use std::time::Duration;

async fn blocked_migration(pool: &PgPool) -> (PgPool, Transaction<'static, Postgres>, i32) {
    let mut initial = sqlx::migrate!();
    initial
        .migrations
        .to_mut()
        .retain(|migration| migration.version < 202611090075);
    initial.run(pool).await.unwrap();
    let startup = startup_pool(pool).await;
    let pid = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&startup)
        .await
        .unwrap();
    let mut reader = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE sessions IN ACCESS SHARE MODE")
        .execute(&mut *reader)
        .await
        .unwrap();
    (startup, reader, pid)
}

async fn incoming_timeouts(startup: &PgPool, statement: &str, transaction: &str) {
    let mut connection = startup.acquire().await.unwrap();
    let settings: (String, String) = sqlx::query_as(
        "SELECT set_config('statement_timeout', $1, false), \
         set_config('transaction_timeout', $2, false)",
    )
    .bind(statement)
    .bind(transaction)
    .fetch_one(&mut *connection)
    .await
    .unwrap();
    assert_eq!(settings, (statement.into(), transaction.into()));
    connection.return_to_pool().await;
}

async fn wait_for_blocked_ddl(pool: &PgPool, pid: i32) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let blocked: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT FROM pg_stat_activity WHERE pid = $1 \
                 AND wait_event_type = 'Lock' AND query LIKE '%DROP INDEX sessions_expiry%' \
                 AND cardinality(pg_blocking_pids(pid)) > 0)",
            )
            .bind(pid)
            .fetch_one(pool)
            .await
            .unwrap();
            if blocked {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("migration must reach the deliberately blocked DDL");
    // Start the delay only after observing the real migration transaction.
    // This exceeds each incoming 100 ms timeout, but not the 5 s lock limit.
    tokio::time::sleep(Duration::from_millis(500)).await;
}

async fn assert_replacement(startup: &PgPool, pid: i32) {
    assert_eq!(
        timeouts(startup).await,
        ("0".into(), "10s".into(), "0".into())
    );
    let replacement: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(startup)
        .await
        .unwrap();
    assert_ne!(replacement, pid, "migration connection must be discarded");
}

async fn migration_outlasts_incoming_timeout(pool: PgPool, statement: &str, transaction: &str) {
    let (startup, reader, pid) = blocked_migration(&pool).await;
    incoming_timeouts(&startup, statement, transaction).await;
    let (result, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(migrate(&startup), async {
            wait_for_blocked_ddl(&pool, pid).await;
            reader.rollback().await.unwrap();
        })
    })
    .await
    .unwrap();
    result.expect("migration must outlast the incoming timeout");
    validate_migrations(&startup).await.unwrap();
    assert_replacement(&startup, pid).await;
    startup.close().await;
}

#[fukulow_test::test(migrations = false)]
async fn startup_migrations_disable_incoming_statement_timeout(pool: PgPool) {
    migration_outlasts_incoming_timeout(pool, "100ms", "0").await;
}

#[fukulow_test::test(migrations = false)]
async fn startup_migrations_disable_incoming_transaction_timeout(pool: PgPool) {
    migration_outlasts_incoming_timeout(pool, "10s", "100ms").await;
}

#[fukulow_test::test(migrations = false)]
async fn startup_migrations_cancellation_discards_settings_and_can_retry(pool: PgPool) {
    let (startup, reader, pid) = blocked_migration(&pool).await;
    incoming_timeouts(&startup, "100ms", "100ms").await;
    {
        let migration = migrate(&startup);
        tokio::pin!(migration);
        tokio::select! {
            result = &mut migration => panic!("migration must remain blocked until cancellation: {result:?}"),
            () = wait_for_blocked_ddl(&pool, pid) => {}
        }
        // Dropping the polled future cancels real in-flight DDL while its lock
        // blocker is still held, exercising the migration connection's guard.
    }
    assert_replacement(&startup, pid).await;
    let unchanged: (bool, i64) = sqlx::query_as(
        "SELECT to_regclass('public.sessions_expiry') IS NOT NULL, \
         (SELECT count(*) FROM _sqlx_migrations WHERE version = 202611090075)",
    )
    .fetch_one(&startup)
    .await
    .unwrap();
    assert_eq!(unchanged, (true, 0));
    reader.rollback().await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), migrate(&startup))
        .await
        .expect("cancelled migration must release its advisory lock for retry")
        .unwrap();
    validate_migrations(&startup).await.unwrap();
    assert_eq!(
        timeouts(&startup).await,
        ("0".into(), "10s".into(), "0".into())
    );
    startup.close().await;
}
