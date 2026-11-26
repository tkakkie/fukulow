use crate::test_support::TestPools;
use sqlx::{PgConnection, PgPool};

// Carries the app session settings; migrations must override them and never
// leak their own settings back.
pub(super) async fn startup_pool(pool: &PgPool) -> PgPool {
    super::PoolConfig::configured(None, None)
        .unwrap()
        .options()
        .max_connections(1)
        .connect_with(super::pool::session(
            pool.connect_options().as_ref().clone(),
        ))
        .await
        .unwrap()
}

pub(crate) async fn pools(pool: PgPool) -> TestPools {
    TestPools::new(startup_pool(&pool).await).await
}

/// Each healthy helper transaction checks out once; count both reused and new sockets.
pub(crate) async fn counted_pool(
    pool: &PgPool,
) -> (PgPool, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let count = Arc::new(AtomicUsize::new(0));
    let counted = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .test_before_acquire(false)
        .idle_timeout(None)
        .max_lifetime(None)
        .before_acquire({
            let count = count.clone();
            move |_, _| {
                count.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(true) })
            }
        })
        .after_connect({
            let count = count.clone();
            move |_, _| {
                count.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(()) })
            }
        })
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    count.store(0, Ordering::SeqCst);
    (counted, count)
}

pub(crate) async fn settings(tx: &mut PgConnection) -> (Option<String>, Option<String>) {
    sqlx::query_as(
        "SELECT NULLIF(current_setting('fukulow.organization_id', true), ''), \
        NULLIF(current_setting('fukulow.account_id', true), '')",
    )
    .fetch_one(tx)
    .await
    .unwrap()
}

pub(crate) async fn clean(pool: &PgPool) -> i32 {
    let mut tx = pool.begin().await.unwrap();
    assert_eq!(settings(&mut tx).await, (None, None));
    let (pid, read_only): (i32, String) =
        sqlx::query_as("SELECT pg_backend_pid(), current_setting('transaction_read_only')")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(read_only, "off");
    tx.rollback().await.unwrap();
    pid
}

pub(super) async fn single_connection_pool(pool: &PgPool) -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap()
}

/// Opt-in call-site guard, only in an isolated sqlx test database. Production RLS
/// remains disabled. Account context grants SELECT only on the caller's Members
/// and their Organizations; every other access requires Organization context.
pub(crate) async fn context_policies(admin: &PgPool) {
    const APP_ROLE: &str = "fukulow_sqlx_test_app";
    for table in [
        "organizations",
        "users",
        "channels",
        "channel_members",
        "channel_message_sequences",
        "messages",
        "channel_log",
        "operation_receipts",
        "topics",
        "channel_read_positions",
        "topic_read_positions",
        "invites",
    ] {
        sqlx::raw_sql(&format!(
            "ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
             CREATE POLICY context_organization ON {table} TO {APP_ROLE}
             USING (organization_id = NULLIF(current_setting('fukulow.organization_id', true), '')::uuid)
             WITH CHECK (organization_id = NULLIF(current_setting('fukulow.organization_id', true), '')::uuid);"
        ))
        .execute(admin)
        .await
        .unwrap();
    }
    sqlx::raw_sql(
        "CREATE POLICY context_account ON users FOR SELECT TO fukulow_sqlx_test_app
         USING (account_id = NULLIF(current_setting('fukulow.account_id', true), '')::uuid);
         CREATE POLICY context_account ON organizations FOR SELECT TO fukulow_sqlx_test_app
         USING (EXISTS (SELECT 1 FROM users u WHERE u.organization_id = organizations.organization_id
            AND u.account_id = NULLIF(current_setting('fukulow.account_id', true), '')::uuid
            AND u.deactivated_at IS NULL));",
    )
    .execute(admin)
    .await
    .unwrap();
}
