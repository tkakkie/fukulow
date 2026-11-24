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
