#![cfg(test)]

#[path = "../src/test_support.rs"]
mod test_support;

use futures_util::FutureExt;
use sqlx::PgPool;
use std::{panic::AssertUnwindSafe, time::Duration};
use test_support::TestPools;

async fn assert_app_backends_closed(
    admin: &PgPool,
    apps: &[PgPool],
    expected_pids: &[i32],
    timeout_ms: i64,
) {
    // Check the harness before signalling anything: an open pool must fail, not
    // have its connections cleaned up by pg_terminate_backend.
    for app in apps {
        assert!(app.is_closed(), "harness left an app pool open");
        assert_eq!(app.size(), 0);
    }
    let unexpected: Vec<i32> = sqlx::query_scalar(
        "SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND usename = 'fukulow_sqlx_test_app'
         AND NOT (pid = ANY($1))",
    )
    .bind(expected_pids)
    .fetch_all(admin)
    .await
    .unwrap();
    assert!(
        unexpected.is_empty(),
        "harness left unexpected app backend PIDs: {unexpected:?}"
    );
    // SQLx sends Terminate and closes its socket without a server acknowledgement.
    // A positive timeout waits for actual backend exit, including exit callbacks.
    // Restrict signals to the expected app backends in this test database.
    let waits: Vec<(i32, bool)> = sqlx::query_as(
        "SELECT pid, pg_terminate_backend(pid, $1) FROM pg_stat_activity
         WHERE datname = current_database() AND usename = 'fukulow_sqlx_test_app'
         AND pid = ANY($2)",
    )
    .bind(timeout_ms)
    .bind(expected_pids)
    .fetch_all(admin)
    .await
    .unwrap();
    // A false result can also mean the backend exited before receiving the signal.
    // Use a new statement/snapshot to establish the postcondition in either case.
    let remaining: Vec<i32> = sqlx::query_scalar(
        "SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND usename = 'fukulow_sqlx_test_app'",
    )
    .fetch_all(admin)
    .await
    .unwrap();
    assert!(
        remaining.is_empty(),
        "app backends did not exit within {timeout_ms}ms per backend; remaining PIDs: \
         {remaining:?}; termination waits: {waits:?}"
    );
}

#[fukulow_test::test]
async fn backend_exit_can_outlive_pool_close(pool: PgPool) {
    let app = TestPools::new(pool.clone()).await.app;
    // Test-only fault injection: temporary-table cleanup runs during backend exit.
    // Keep ownership on admin: TestPools rejects app-owned objects cluster-wide,
    // including temporary objects in concurrently running tests' databases.
    sqlx::raw_sql(
        "CREATE FUNCTION create_exit_barrier() RETURNS text
         LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
         BEGIN
             CREATE TEMP TABLE exit_barrier (id int);
             RETURN pg_my_temp_schema()::regnamespace::text;
         END $$",
    )
    .execute(&pool)
    .await
    .unwrap();
    let mut connection = app.acquire().await.unwrap();
    let (pid, schema): (i32, String) =
        sqlx::query_as("SELECT pg_backend_pid(), create_exit_barrier()")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
    let mut barrier = pool.begin().await.unwrap();
    sqlx::query(&format!(
        "LOCK TABLE {schema}.exit_barrier IN ACCESS SHARE MODE"
    ))
    .execute(&mut *barrier)
    .await
    .unwrap();
    drop(connection);
    app.close().await;
    assert!(app.is_closed());
    assert_eq!(app.size(), 0);
    let remaining: Vec<i32> = sqlx::query_scalar(
        "SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND usename = 'fukulow_sqlx_test_app'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    // The old immediate zero-backend assertion deterministically fails here.
    assert_eq!(remaining, [pid]);
    let failure = AssertUnwindSafe(assert_app_backends_closed(
        &pool,
        std::slice::from_ref(&app),
        &[pid],
        20,
    ))
    .catch_unwind()
    .await
    .unwrap_err();
    let message = failure.downcast_ref::<String>().unwrap();
    assert!(message.contains("remaining PIDs"));
    assert!(message.contains(&pid.to_string()));
    barrier.rollback().await.unwrap();
    assert_app_backends_closed(&pool, &[app], &[pid], 5_000).await;
}

#[fukulow_test::test]
async fn backend_exit_assertion_rejects_an_open_app_pool(pool: PgPool) {
    let app = TestPools::new(pool.clone()).await.app;
    let mut connection = app.acquire().await.unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *connection)
        .await
        .unwrap();
    let failure = AssertUnwindSafe(assert_app_backends_closed(
        &pool,
        std::slice::from_ref(&app),
        &[pid],
        5_000,
    ))
    .catch_unwind()
    .await
    .unwrap_err();
    assert_eq!(
        failure.downcast_ref::<&str>(),
        Some(&"harness left an app pool open")
    );
    // The assertion must fail before killing an open pool's backend.
    sqlx::query("SELECT 1")
        .execute(&mut *connection)
        .await
        .unwrap();

    let closed_app = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy_with(app.connect_options().as_ref().clone());
    closed_app.close().await;
    for apps in [&[][..], std::slice::from_ref(&closed_app)] {
        let failure = AssertUnwindSafe(assert_app_backends_closed(&pool, apps, &[], 5_000))
            .catch_unwind()
            .await
            .unwrap_err();
        let message = failure.downcast_ref::<String>().unwrap();
        assert!(message.contains("unexpected app backend PIDs"));
        assert!(message.contains(&pid.to_string()));
        let value: i32 = sqlx::query_scalar("SELECT 1")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
        assert_eq!(value, 1);
    }
}

#[fukulow_test::test]
async fn repeated_app_construction_keeps_one_database_connection_budget(pool: PgPool) {
    let mut retained = Vec::new();
    let (first, second) = tokio::join!(TestPools::new(pool.clone()), TestPools::new(pool.clone()));
    retained.extend([first.app, second.app]);
    for _ in 0..24 {
        let app = TestPools::new(pool.clone()).await.app;
        sqlx::query("SELECT 1").execute(&app).await.unwrap();
        retained.push(app);
    }
    let connections: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_stat_activity
         WHERE datname = current_database() AND usename = 'fukulow_sqlx_test_app'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        connections <= i64::from(pool.options().get_max_connections()),
        "repeated app construction retained {connections} connections"
    );
    assert_eq!(
        retained[0].options().get_idle_timeout(),
        pool.options().get_idle_timeout()
    );
}

#[fukulow_test::test]
async fn explicitly_closed_app_pools_can_be_replaced_with_retained_handles(pool: PgPool) {
    let mut retained = Vec::new();
    for _ in 0..24 {
        let app = TestPools::new(pool.clone()).await.app;
        sqlx::query("SELECT 1").execute(&app).await.unwrap();
        app.close().await;
        retained.push(app);
    }
    assert!(retained.iter().all(PgPool::is_closed));
}

#[fukulow_test::test]
async fn harness_closes_all_app_pools_with_retained_handles(pool: PgPool) {
    let other_admin = sqlx::postgres::PgPoolOptions::new()
        .max_connections(pool.options().get_max_connections())
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    let (apps, expected_pids) = test_support::run(async {
        let first = TestPools::new(pool.clone()).await;
        let second = TestPools::new(other_admin.clone()).await;
        let expected_pids: Vec<i32> = sqlx::query_scalar(
            "SELECT pid FROM pg_stat_activity
             WHERE datname = current_database() AND usename = 'fukulow_sqlx_test_app'",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        // Retained handles model application state/background tasks outliving the body.
        ((first.app, second.app), expected_pids)
    })
    .await;
    other_admin.close().await;
    assert_app_backends_closed(&pool, &[apps.0, apps.1], &expected_pids, 5_000).await;
}

#[fukulow_test::test]
async fn harness_closes_app_pools_on_error_and_panic(pool: PgPool) {
    let mut retained = None;
    let result: Result<(), &str> = test_support::run(async {
        retained = Some(TestPools::new(pool.clone()).await.app);
        Err("early return")?;
        Ok(())
    })
    .await;
    assert_eq!(result, Err("early return"));
    assert_eq!(retained.as_ref().unwrap().size(), 0);
    assert!(retained.as_ref().unwrap().is_closed());

    let result = AssertUnwindSafe(test_support::run(async {
        retained = Some(TestPools::new(pool.clone()).await.app);
        panic!("test body failed");
    }))
    .catch_unwind()
    .await;
    assert!(result.is_err());
    assert_eq!(retained.as_ref().unwrap().size(), 0);
    assert!(retained.as_ref().unwrap().is_closed());
}

#[fukulow_test::test]
async fn harness_bounds_leaked_connections_and_attempts_every_app_pool(pool: PgPool) {
    let mut admins = Vec::new();
    let mut apps = Vec::new();
    let mut connections = Vec::new();
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        AssertUnwindSafe(test_support::run_with_close_timeout(
            async {
                for index in 0..3 {
                    let admin = sqlx::postgres::PgPoolOptions::new()
                        .connect_lazy_with(pool.connect_options().as_ref().clone());
                    admins.push(admin.clone());
                    let app = TestPools::new(admin).await.app;
                    if index < 2 {
                        connections.push(app.acquire().await.unwrap());
                    }
                    apps.push(app);
                }
            },
            Duration::from_millis(200),
        ))
        .catch_unwind(),
    )
    .await;
    let closed = apps.iter().all(PgPool::is_closed);
    let healthy_pool_size = apps.last().unwrap().size();
    connections.clear();
    for app in apps.iter().chain(&admins) {
        app.close().await;
    }
    let panic = result.expect("pool cleanup must be bounded").unwrap_err();
    let message = panic.downcast_ref::<String>().unwrap();
    assert!(message.contains("app pool #1"));
    assert!(message.contains("app pool #2"));
    assert!(message.contains(pool.connect_options().get_database().unwrap()));
    assert!(message.contains("checked-out connection may have leaked"));
    assert!(closed);
    assert_eq!(healthy_pool_size, 0);
}

#[fukulow_test::test]
async fn harness_preserves_body_panic_when_app_pool_close_times_out(pool: PgPool) {
    let mut retained = None;
    let mut connection = None;
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        AssertUnwindSafe(test_support::run_with_close_timeout(
            async {
                let app = TestPools::new(pool.clone()).await.app;
                connection = Some(app.acquire().await.unwrap());
                retained = Some(app);
                panic!("original body panic");
            },
            Duration::from_millis(200),
        ))
        .catch_unwind(),
    )
    .await;
    drop(connection);
    let app = retained.unwrap();
    assert!(app.is_closed());
    app.close().await;
    let panic = result.expect("pool cleanup must be bounded").unwrap_err();
    assert_eq!(panic.downcast_ref::<&str>(), Some(&"original body panic"));
}

// Negative guard: a test without the wrapper fails before opening app connections.
#[tokio::test]
#[should_panic(expected = "TestPools requires #[fukulow_test::test]")]
async fn unmanaged_app_pool_is_rejected() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://postgres:ci-test-only@127.0.0.1:5432/postgres")
        .unwrap();
    let _pools = TestPools::new(pool).await;
}

#[fukulow_test::test]
async fn app_pool_is_restricted_and_admin_remains_separate(pool: PgPool) {
    let pools = TestPools::new(pool).await;
    let flags: (String, bool, bool, bool, bool) = sqlx::query_as(
        "SELECT current_user::text, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
         FROM pg_roles WHERE rolname = current_user",
    )
    .fetch_one(&pools.app)
    .await
    .unwrap();
    assert_eq!(
        flags,
        ("fukulow_sqlx_test_app".into(), false, false, false, false)
    );
    let owned_tables: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relowner = current_user::regrole",
    )
    .fetch_one(&pools.app)
    .await
    .unwrap();
    assert_eq!(owned_tables, 0);
    let same_database_and_admin: bool = sqlx::query_scalar(
        "SELECT current_database() = $1 AND rolsuper FROM pg_roles WHERE rolname = current_user",
    )
    .bind(pools.app.connect_options().get_database())
    .fetch_one(&pools.admin)
    .await
    .unwrap();
    assert!(same_database_and_admin);
    let migrations: i64 = sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations")
        .fetch_one(&pools.app)
        .await
        .unwrap();
    assert!(migrations > 0);
    let error = sqlx::query("INSERT INTO _sqlx_migrations SELECT * FROM _sqlx_migrations LIMIT 1")
        .execute(&pools.app)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("42501")
    );
    // Objects created later by admin inherit the production default grants,
    // including sequence USAGE, but remain owned by admin.
    sqlx::raw_sql(
        "CREATE TABLE harness_grants (organization_id uuid NOT NULL, id bigserial PRIMARY KEY)",
    )
    .execute(&pools.admin)
    .await
    .unwrap();
    let id: i64 =
        sqlx::query_scalar("INSERT INTO harness_grants (organization_id) VALUES ($1) RETURNING id")
            .bind(uuid::Uuid::new_v4())
            .fetch_one(&pools.app)
            .await
            .unwrap();
    assert_eq!(id, 1);
    for statement in [
        "UPDATE harness_grants SET organization_id = organization_id WHERE id = $1",
        "DELETE FROM harness_grants WHERE id = $1",
    ] {
        assert_eq!(
            sqlx::query(statement)
                .bind(id)
                .execute(&pools.app)
                .await
                .unwrap()
                .rows_affected(),
            1
        );
    }
    let error = sqlx::raw_sql("ALTER TABLE harness_grants ADD COLUMN denied text")
        .execute(&pools.app)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("42501")
    );
    pools.app.close().await;
}
