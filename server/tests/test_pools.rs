#![cfg(test)]

#[path = "support/pools.rs"]
mod test_support;

use futures_util::FutureExt;
use sqlx::PgPool;
use std::panic::AssertUnwindSafe;
use test_support::TestPools;

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
    let apps = test_support::run(async {
        let first = TestPools::new(pool.clone()).await;
        let second = TestPools::new(other_admin.clone()).await;
        // Retained handles model application state/background tasks outliving the body.
        (first.app, second.app)
    })
    .await;
    other_admin.close().await;
    assert!(apps.0.is_closed());
    assert!(apps.1.is_closed());
    assert_eq!(apps.0.size(), 0);
    assert_eq!(apps.1.size(), 0);
    let remaining: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_stat_activity
         WHERE datname = current_database() AND usename = 'fukulow_sqlx_test_app'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(remaining, 0);
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
