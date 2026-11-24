use futures_util::FutureExt;
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::panic::AssertUnwindSafe;

#[fukulow_test::test]
async fn test_app_pool_rejects_non_superuser_bypassrls_role(admin: PgPool) {
    let role = format!("test_bypassrls_{}", uuid::Uuid::new_v4().simple());
    sqlx::raw_sql(&format!(
        "CREATE ROLE {role} LOGIN NOSUPERUSER BYPASSRLS PASSWORD 'bypassrls-test-only'"
    ))
    .execute(&admin)
    .await
    .unwrap();

    let pool = PgPoolOptions::new().connect_lazy_with(
        admin
            .connect_options()
            .as_ref()
            .clone()
            .username(&role)
            .password("bypassrls-test-only"),
    );
    let result = AssertUnwindSafe(crate::test_app_pool(pool.clone()))
        .catch_unwind()
        .await;
    pool.close().await;
    sqlx::raw_sql(&format!("DROP ROLE {role}"))
        .execute(&admin)
        .await
        .unwrap();
    let panic = result.unwrap_err();
    assert_eq!(
        panic.downcast_ref::<String>().unwrap(),
        &format!("test app pool role {role} has BYPASSRLS")
    );
}

#[fukulow_test::test]
async fn test_app_pool_rejects_table_owner_and_owner_role_member(admin: PgPool) {
    let suffix = uuid::Uuid::new_v4().simple();
    let owner = format!("test_owner_{suffix}");
    let member = format!("test_member_{suffix}");
    sqlx::raw_sql(&format!(
        "CREATE ROLE {owner} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD 'owner-test-only';
         CREATE ROLE {member} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD 'owner-test-only';
         CREATE TABLE test_owned_table (id integer);
         ALTER TABLE test_owned_table OWNER TO {owner};"
    ))
    .execute(&admin)
    .await
    .unwrap();

    let mut results = Vec::new();
    for role in [&owner, &member] {
        if role == &member {
            sqlx::raw_sql(&format!("GRANT {owner} TO {member}"))
                .execute(&admin)
                .await
                .unwrap();
        }
        let pool = PgPoolOptions::new().connect_lazy_with(
            admin
                .connect_options()
                .as_ref()
                .clone()
                .username(role)
                .password("owner-test-only"),
        );
        let result = AssertUnwindSafe(crate::test_app_pool(pool.clone()))
            .catch_unwind()
            .await;
        pool.close().await;
        results.push((role, result));
    }
    sqlx::raw_sql(&format!(
        "DROP TABLE test_owned_table; DROP ROLE {member}, {owner};"
    ))
    .execute(&admin)
    .await
    .unwrap();
    for (role, result) in results {
        let panic = result.unwrap_err();
        assert_eq!(
            panic.downcast_ref::<String>().unwrap(),
            &format!("test app role {role} must be restricted and own nothing")
        );
    }
}
