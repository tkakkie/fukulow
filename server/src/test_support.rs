use futures_util::FutureExt;
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{cell::RefCell, future::Future, panic::AssertUnwindSafe, sync::Arc, time::Duration};
use tokio::sync::OnceCell;

struct AppPool {
    admin: PgPool,
    app: Arc<OnceCell<PgPool>>,
}

tokio::task_local! {
    static APP_POOLS: RefCell<Vec<AppPool>>;
}

pub async fn run<F: Future>(test: F) -> F::Output {
    run_with_close_timeout(test, Duration::from_secs(10)).await
}

pub(crate) async fn run_with_close_timeout<F: Future>(
    test: F,
    close_timeout: Duration,
) -> F::Output {
    APP_POOLS
        .scope(RefCell::new(Vec::new()), async {
            let result = AssertUnwindSafe(test).catch_unwind().await;
            let pools = APP_POOLS.with(|pools| pools.take());
            let timeouts = close_app_pools(pools, close_timeout).await;
            match result {
                Ok(output) => {
                    assert!(timeouts.is_empty(), "{}", timeouts.join("\n"));
                    output
                }
                Err(panic) => std::panic::resume_unwind(panic),
            }
        })
        .await
}

async fn close_app_pools(pools: Vec<AppPool>, close_timeout: Duration) -> Vec<String> {
    let mut timeouts = Vec::new();
    for (index, pool) in pools.into_iter().enumerate() {
        if let Some(app) = pool.app.get()
            && tokio::time::timeout(close_timeout, app.close())
                .await
                .is_err()
        {
            let message = format!(
                "timed out after {close_timeout:?} closing app pool #{} (database {:?}); \
                 a checked-out connection may have leaked",
                index + 1,
                app.connect_options().get_database(),
            );
            // Cleanup must not replace a panic from the test body.
            eprintln!("{message}");
            timeouts.push(message);
        }
    }
    timeouts
}

const APP_ROLE: &str = "fukulow_sqlx_test_app";

/// Use `let pools = TestPools::new(pool).await` in a `#[fukulow_test::test]`.
/// Pass `pools.app` to application state/queries; keep fixtures, migrations, DDL
/// and fault injection on `pools.admin`. Never use this against a shared cluster.
/// The test-only role persists across runs; no real `fukulow_app` is changed.
/// The test harness closes every app pool before returning to SQLx, even when
/// application state or background tasks retain pool handles. Apps over the same
/// admin pool share one restricted pool, including concurrent initialization.
/// This conventional module path keeps the invariants check's module tree resolvable;
/// integration tests share it through `tests/support/pools.rs`.
pub struct TestPools {
    pub admin: PgPool,
    pub app: PgPool,
}

impl TestPools {
    pub async fn new(admin: PgPool) -> Self {
        assert!(
            APP_POOLS.try_with(|_| ()).is_ok(),
            "TestPools requires #[fukulow_test::test] to close app pools before SQLx teardown"
        );
        let cell = APP_POOLS.with(|pools| {
            let mut pools = pools.borrow_mut();
            if let Some(pool) = pools.iter().find(|pool| {
                std::ptr::eq(pool.admin.options(), admin.options())
                    && pool.app.get().is_none_or(|app| !app.is_closed())
            }) {
                return pool.app.clone();
            }
            let app = Arc::new(OnceCell::new());
            pools.push(AppPool {
                admin: admin.clone(),
                app: app.clone(),
            });
            app
        });
        let app = cell.get_or_init(|| Self::open(&admin)).await.clone();
        Self { admin, app }
    }

    async fn open(admin: &PgPool) -> PgPool {
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
        // Closed pools may retain handles until teardown. SQLx parent permits are
        // returned only on Drop, so keep the app budget independent of the admin pool.
        PgPoolOptions::new()
            .max_connections(admin.options().get_max_connections())
            .idle_timeout(admin.options().get_idle_timeout())
            .connect_with(
                admin
                    .connect_options()
                    .as_ref()
                    .clone()
                    .username(APP_ROLE)
                    .password("sqlx-app-test-only"),
            )
            .await
            .unwrap()
    }
}
