use sqlx::{PgPool, postgres::PgPoolOptions};

const APP_ROLE: &str = "fukulow_sqlx_test_app";

/// Opt in with `let pools = TestPools::new(pool).await` in a `#[sqlx::test]`.
/// Pass `pools.app` to application state/queries; keep fixtures, migrations, DDL
/// and fault injection on `pools.admin`. Never use this against a shared cluster.
/// The test-only role persists across runs; no real `fukulow_app` is changed.
/// Close `pools.app` before returning so SQLx can drop the test database.
/// This conventional module path keeps the invariants check's module tree resolvable;
/// integration tests share it through `tests/support/pools.rs`.
pub struct TestPools {
    pub admin: PgPool,
    pub app: PgPool,
}

impl TestPools {
    pub async fn new(admin: PgPool) -> Self {
        let mut transaction = admin.begin().await.unwrap();
        // Serialize grants when callers initialize the same test database together.
        // Advisory locks are database-local; role creation also handles cross-DB races.
        sqlx::query("SELECT pg_advisory_xact_lock(314, 1)")
            .execute(&mut *transaction)
            .await
            .unwrap();
        sqlx::raw_sql(
            "DO $$ BEGIN
                IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fukulow_sqlx_test_app') THEN
                    BEGIN
                        CREATE ROLE fukulow_sqlx_test_app LOGIN NOSUPERUSER NOBYPASSRLS
                            NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION
                            PASSWORD 'sqlx-app-test-only';
                    EXCEPTION WHEN duplicate_object OR unique_violation THEN
                        -- Concurrent CREATE ROLE can race at pg_authid's unique index.
                        NULL;
                    END;
                END IF;
            END $$;",
        )
        .execute(&mut *transaction)
        .await
        .unwrap();
        // Fail rather than silently reuse a privileged, owning or member role.
        let restricted: bool = sqlx::query_scalar(
            "SELECT rolcanlogin AND NOT (rolsuper OR rolbypassrls OR rolcreatedb OR
                rolcreaterole OR rolinherit OR rolreplication)
                AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member = r.oid OR roleid = r.oid)
                AND NOT EXISTS (SELECT FROM pg_shdepend WHERE refclassid = 'pg_authid'::regclass
                    AND refobjid = r.oid AND deptype = 'o')
             FROM pg_roles r WHERE rolname = $1",
        )
        .bind(APP_ROLE)
        .fetch_one(&mut *transaction)
        .await
        .unwrap();
        assert!(
            restricted,
            "test app role must be restricted and own nothing"
        );
        // Production SQL hardcodes its role. Substitute only that identifier,
        // keeping database/schema/table/sequence/default grants single-sourced.
        let grants = include_str!("../../deploy/db-grants.sql").replace("fukulow_app", APP_ROLE);
        sqlx::raw_sql(&grants)
            .execute(&mut *transaction)
            .await
            .unwrap();
        transaction.commit().await.unwrap();
        let app = PgPoolOptions::new()
            .max_connections(admin.options().get_max_connections())
            .connect_with(
                admin
                    .connect_options()
                    .as_ref()
                    .clone()
                    .username(APP_ROLE)
                    .password("sqlx-app-test-only"),
            )
            .await
            .unwrap();
        Self { admin, app }
    }
}
