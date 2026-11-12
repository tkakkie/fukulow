#![cfg(test)]

#[path = "support/pools.rs"]
mod support;

use sqlx::PgPool;
use support::TestPools;

#[sqlx::test]
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
