use super::*;
use sqlx::PgPool;

#[fukulow_test::test]
async fn startup_role_check_accepts_sqlx_app_role(pool: PgPool) {
    let app = crate::test_app_pool(pool).await;
    PoolConfig::validate_app_role(&app).await.unwrap();
}

#[sqlx::test]
async fn startup_role_check_rejects_superuser(pool: PgPool) {
    assert_role_rejected(pool, "ALTER ROLE test_role SUPERUSER").await;
}

#[sqlx::test]
async fn startup_role_check_rejects_bypassrls(pool: PgPool) {
    assert_role_rejected(pool, "ALTER ROLE test_role BYPASSRLS").await;
}

#[sqlx::test]
async fn startup_role_check_rejects_public_relation_owner(pool: PgPool) {
    assert_role_rejected(
        pool,
        "CREATE SEQUENCE public.owned_sequence; ALTER SEQUENCE public.owned_sequence OWNER TO test_role",
    )
    .await;
}

#[sqlx::test]
async fn startup_role_check_rejects_role_member(pool: PgPool) {
    assert_role_rejected(
        pool,
        "CREATE ROLE test_role_peer; GRANT test_role_peer TO test_role WITH INHERIT FALSE, SET FALSE",
    )
    .await;
}

#[sqlx::test]
async fn startup_role_check_rejects_role_with_members(pool: PgPool) {
    assert_role_rejected(
        pool,
        "CREATE ROLE test_role_peer; GRANT test_role TO test_role_peer",
    )
    .await;
}

#[sqlx::test]
async fn startup_role_check_rejects_implicit_database_owner_membership(pool: PgPool) {
    assert_role_rejected(
        pool,
        "DO $$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO test_role', current_database()); END $$",
    )
    .await;
}

async fn assert_role_rejected(pool: PgPool, setup: &str) {
    let role = format!("startup_test_{}", uuid::Uuid::new_v4().simple());
    // Roles are cluster-wide. Roll back all fixtures, even on assertion failure.
    let mut tx = pool.begin().await.unwrap();
    sqlx::raw_sql(&format!(
        "CREATE ROLE {role} LOGIN NOINHERIT; SET LOCAL ROLE {role}"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    validate_app_role(&mut tx).await.unwrap();
    let setup =
        format!("RESET ROLE; {setup}; SET LOCAL ROLE test_role").replace("test_role", &role);
    sqlx::raw_sql(&setup).execute(&mut *tx).await.unwrap();
    assert_eq!(validate_app_role(&mut tx).await, Err(APP_ROLE_ERROR));
    tx.rollback().await.unwrap();
}

#[test]
fn pool_configuration_defaults_bounds_and_overrides() {
    let defaults = PoolConfig::configured(None, None).unwrap().options();
    assert_eq!(defaults.get_max_connections(), 20);
    assert_eq!(defaults.get_acquire_timeout(), Duration::from_secs(5));
    for size in ["3", "4", "20", "100"] {
        for timeout in ["1", "250", "5000"] {
            let options = PoolConfig::configured(Some(size), Some(timeout))
                .unwrap()
                .options();
            assert_eq!(options.get_max_connections(), size.parse::<u32>().unwrap());
            assert_eq!(
                options.get_acquire_timeout(),
                Duration::from_millis(timeout.parse().unwrap())
            );
        }
    }
    for value in [
        "",
        "0",
        "1",
        "2",
        "-3",
        "3.5",
        " 20",
        "101",
        "4294967295",
        "4294967296",
        "many",
    ] {
        assert!(
            PoolConfig::configured(Some(value), None).is_err(),
            "{value}"
        );
    }
    for value in ["", "0", "-1", "1.5", "5001", "18446744073709551616", "soon"] {
        assert!(
            PoolConfig::configured(None, Some(value)).is_err(),
            "{value}"
        );
    }
}

#[fukulow_test::test]
async fn maximum_pool_constructs_and_next_size_is_rejected(pool: PgPool) {
    assert!(PoolConfig::configured(Some("101"), None).is_err());
    // Construct SQLx's real pool (including its eagerly allocated idle queue),
    // without requiring 100 PostgreSQL backends to be open simultaneously.
    let app = PoolConfig::configured(Some("100"), None)
        .unwrap()
        .options()
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    assert_eq!(app.options().get_max_connections(), 100);
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT 1")
            .fetch_one(&app)
            .await
            .unwrap(),
        1
    );
    app.close().await;
}

#[fukulow_test::test]
async fn configured_pool_bounds_acquisition_and_sets_every_new_connection(pool: PgPool) {
    // URL-supplied options cannot weaken the app's own startup parameters.
    let app = PoolConfig::configured(Some("3"), Some("1000"))
        .unwrap()
        .connect_with(
            pool.connect_options()
                .as_ref()
                .clone()
                .options([("statement_timeout", "0"), ("jit", "on")]),
        )
        .await
        .unwrap();
    let mut held = Vec::new();
    for _ in 0..3 {
        let mut connection = app.acquire().await.unwrap();
        assert_eq!(
            settings(&mut connection).await,
            ("10s".into(), "off".into())
        );
        held.push(connection);
    }
    let started = tokio::time::Instant::now();
    assert!(matches!(
        app.acquire().await,
        Err(sqlx::Error::PoolTimedOut)
    ));
    assert!(started.elapsed() >= Duration::from_secs(1));
    assert!(started.elapsed() < Duration::from_secs(3));
    for connection in held {
        connection.close().await.unwrap();
    }
    // Replacement connections carry them too.
    let mut connection = app.acquire().await.unwrap();
    assert_eq!(
        settings(&mut connection).await,
        ("10s".into(), "off".into())
    );
    drop(connection);
    validate_session_settings(&app).await.unwrap();
    app.close().await;
}

async fn settings(connection: &mut sqlx::PgConnection) -> (String, String) {
    sqlx::query_as("SELECT current_setting('statement_timeout'), current_setting('jit')")
        .fetch_one(connection)
        .await
        .unwrap()
}

#[fukulow_test::test]
async fn default_acquire_timeout_outlasts_a_1500_ms_pool_wait(pool: PgPool) {
    let app = PoolConfig::configured(Some("3"), None)
        .unwrap()
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    let mut held = Vec::new();
    for _ in 0..3 {
        held.push(app.acquire().await.unwrap());
    }
    let started = tokio::time::Instant::now();
    let release = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        drop(held);
    });
    // 1 s (#388) failed this wait with PoolTimedOut; 5 s waits and succeeds.
    let value: i32 = sqlx::query_scalar("SELECT 1")
        .fetch_one(&app)
        .await
        .unwrap();
    assert_eq!(value, 1);
    assert!(started.elapsed() >= Duration::from_millis(1_500));
    release.await.unwrap();
    app.close().await;
}

#[fukulow_test::test]
async fn startup_session_check_fails_closed_without_session_parameters(pool: PgPool) {
    let check = async |app: PgPool| {
        let result = validate_session_settings(&app)
            .await
            .map_err(|error| error.to_string());
        app.close().await;
        result
    };
    let base = || pool.connect_options().as_ref().clone();
    // Pools built without PoolConfig::connect_with lack the startup parameters.
    for options in [
        base(),
        base().options([("statement_timeout", "0"), ("jit", "off")]),
        base().options([("statement_timeout", "5s"), ("jit", "off")]),
        base().options([("statement_timeout", "10s"), ("jit", "on")]),
    ] {
        let app = PoolConfig::configured(Some("3"), None)
            .unwrap()
            .options()
            .connect_with(options)
            .await
            .unwrap();
        let error = check(app).await.unwrap_err();
        assert!(
            error.contains("statement_timeout = 10s and jit = off"),
            "{error}"
        );
        assert!(error.contains("startup parameters"), "{error}");
    }
    let app = PoolConfig::configured(Some("3"), None)
        .unwrap()
        .connect_with(base())
        .await
        .unwrap();
    check(app).await.unwrap();
}

#[fukulow_test::test]
async fn ordinary_statement_timeout_fires_and_local_context_clears(pool: PgPool) {
    let restricted = crate::test_app_pool(pool).await;
    let app = PoolConfig::configured(Some("3"), None)
        .unwrap()
        .connect_with(restricted.connect_options().as_ref().clone())
        .await
        .unwrap();
    let mut connection = app.acquire().await.unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *connection)
        .await
        .unwrap();
    let mut tx = sqlx::Connection::begin(&mut *connection).await.unwrap();
    crate::database::set_organization(&mut tx, uuid::Uuid::new_v4())
        .await
        .unwrap();
    let started = tokio::time::Instant::now();
    let error = tokio::time::timeout(
        Duration::from_secs(15),
        sqlx::query("SELECT pg_sleep(20)").execute(&mut *tx),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("57014")
    );
    assert!(started.elapsed() >= Duration::from_secs(9));
    tx.rollback().await.unwrap();
    let clean: (i32, String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT pg_backend_pid(), current_setting('statement_timeout'), \
         NULLIF(current_setting('fukulow.organization_id', true), ''), \
         NULLIF(current_setting('fukulow.account_id', true), '')",
    )
    .fetch_one(&mut *connection)
    .await
    .unwrap();
    assert_eq!(clean, (pid, "10s".into(), None, None));
    drop(connection);
    app.close().await;
}
