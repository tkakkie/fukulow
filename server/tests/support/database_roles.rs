use super::*;
use fukulow_server::database::{grants, roles, validate_migrations};
use sqlx::postgres::PgPoolOptions;

async fn app_pool(owner: &PgPool, password: &str) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(4)
        .connect_with(
            owner
                .connect_options()
                .as_ref()
                .clone()
                .username("fukulow_app")
                .password(password),
        )
        .await
}

pub(super) async fn check_app_role(owner: PgPool) {
    // Keep the cluster-wide role/password lifecycle in one test to avoid rotation races.
    // Exercise quotes, backslashes and SQL-looking input without a password in SQL.
    let original = "role-test-only-'\\; DROP TABLE users; --";
    roles(&owner, original).await.unwrap();
    let app = app_pool(&owner, original).await.unwrap();
    validate_migrations(&app).await.unwrap();
    let flags: (bool, bool, bool, bool, bool, bool) = sqlx::query_as(
        "SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls \
         FROM pg_roles WHERE rolname = current_user",
    )
    .fetch_one(&app)
    .await
    .unwrap();
    assert_eq!(flags, (false, false, false, false, false, false));
    let owns_objects: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT FROM pg_shdepend WHERE refobjid = 'fukulow_app'::regrole \
         AND refclassid = 'pg_authid'::regclass AND deptype = 'o')",
    )
    .fetch_one(&owner)
    .await
    .unwrap();
    assert!(!owns_objects);
    for statement in [
        "ALTER TABLE users DISABLE TRIGGER protect_member_identity",
        "DROP TRIGGER protect_member_identity ON users",
        "CREATE OR REPLACE FUNCTION protect_member_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
        "SET session_replication_role = replica",
        "TRUNCATE users CASCADE",
        "TRUNCATE messages CASCADE",
        "CREATE TABLE public.denied (organization_id uuid NOT NULL)",
        "CREATE TEMP TABLE denied (organization_id uuid NOT NULL)",
        "CREATE SCHEMA denied",
        "CREATE FUNCTION public.denied() RETURNS int LANGUAGE sql AS 'SELECT 1'",
        "CREATE TRIGGER denied BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION protect_member_identity()",
        "ALTER TABLE messages ADD COLUMN denied text",
        "DELETE FROM _sqlx_migrations",
        "UPDATE _sqlx_migrations SET success = false",
    ] {
        let error = sqlx::raw_sql(statement).execute(&app).await.unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("42501"),
            "{statement}: {error}"
        );
    }
    let identity = check_member_identity(app.clone()).await;
    check_member_truncate(app.clone(), identity, "42501").await;
    // The existing tenant check sets up its own Organization.
    app.close().await;

    // Clear test-only fixture using the existing tables' owning connection.
    sqlx::raw_sql("ALTER TABLE users DISABLE TRIGGER protect_member_truncate; TRUNCATE organizations, accounts CASCADE; ALTER TABLE users ENABLE TRIGGER protect_member_truncate;")
        .execute(&owner).await.unwrap();
    let app = app_pool(&owner, original).await.unwrap();
    check_tenant_denials(app.clone()).await;

    // Default grants cover objects created later by the migration owner.
    sqlx::raw_sql(
        "CREATE TABLE future_role_test (organization_id uuid NOT NULL, id bigserial PRIMARY KEY)",
    )
    .execute(&owner)
    .await
    .unwrap();
    let organization = Uuid::new_v4();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO future_role_test (organization_id) VALUES ($1) RETURNING id",
    )
    .bind(organization)
    .fetch_one(&app)
    .await
    .unwrap();
    sqlx::query("UPDATE future_role_test SET organization_id = $1 WHERE id = $2")
        .bind(organization)
        .bind(id)
        .execute(&app)
        .await
        .unwrap();
    sqlx::query("DELETE FROM future_role_test WHERE id = $1")
        .bind(id)
        .execute(&app)
        .await
        .unwrap();
    for statement in [
        "TRUNCATE future_role_test",
        "DROP TABLE future_role_test",
        "ALTER SEQUENCE future_role_test_id_seq RESTART",
    ] {
        assert!(sqlx::raw_sql(statement).execute(&app).await.is_err());
    }

    // Reapplying fixes excess direct grants and updates the existing role's password.
    sqlx::raw_sql("GRANT ALL ON ALL TABLES IN SCHEMA public TO fukulow_app; GRANT CREATE ON SCHEMA public TO fukulow_app; ALTER ROLE fukulow_app CREATEDB CREATEROLE")
        .execute(&owner).await.unwrap();
    let updated = "updated-role-test-only";
    roles(&owner, updated).await.unwrap();
    roles(&owner, updated).await.unwrap();
    app.close().await;
    assert!(app_pool(&owner, original).await.is_err());
    let app = app_pool(&owner, updated).await.unwrap();
    grants(&owner).await.unwrap();
    validate_migrations(&app).await.unwrap();
    assert!(
        sqlx::query("TRUNCATE messages CASCADE")
            .execute(&app)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("CREATE TABLE denied (organization_id uuid NOT NULL)")
            .execute(&app)
            .await
            .is_err()
    );
    assert!(roles(&owner, "").await.is_err());
    sqlx::query("ALTER TABLE future_role_test OWNER TO fukulow_app")
        .execute(&owner)
        .await
        .unwrap();
    let error = roles(&owner, "rejected-role-test-only").await.unwrap_err();
    assert_eq!(
        error.to_string(),
        "Database roles update failed (diagnostics suppressed)"
    );
    sqlx::query("ALTER TABLE future_role_test OWNER TO CURRENT_USER")
        .execute(&owner)
        .await
        .unwrap();
    let flags: (bool, bool) = sqlx::query_as(
        "SELECT rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'fukulow_app'",
    )
    .fetch_one(&app)
    .await
    .unwrap();
    assert_eq!(flags, (false, false));
    // A rejected update preserves the previous password and grants.
    let still_works = app_pool(&owner, updated).await.unwrap();
    still_works.close().await;
    app.close().await;
}
