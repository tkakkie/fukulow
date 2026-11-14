use super::*;
use sqlx::PgPool;

#[test]
fn pool_configuration_defaults_bounds_and_overrides() {
    let defaults = PoolConfig::configured(None, None).unwrap().options();
    assert_eq!(defaults.get_max_connections(), 20);
    assert_eq!(defaults.get_acquire_timeout(), Duration::from_secs(1));
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
    let app = PoolConfig::configured(Some("3"), Some("1000"))
        .unwrap()
        .options()
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    let mut held = Vec::new();
    for _ in 0..3 {
        let mut connection = app.acquire().await.unwrap();
        let timeout: String = sqlx::query_scalar("SHOW statement_timeout")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
        assert_eq!(timeout, "10s");
        let jit: String = sqlx::query_scalar("SHOW jit")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
        assert_eq!(jit, "off");
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
    let timeout: String = sqlx::query_scalar("SHOW statement_timeout")
        .fetch_one(&app)
        .await
        .unwrap();
    assert_eq!(timeout, "10s");
    let jit: String = sqlx::query_scalar("SHOW jit")
        .fetch_one(&app)
        .await
        .unwrap();
    assert_eq!(jit, "off");
    app.close().await;
}

#[fukulow_test::test]
async fn ordinary_statement_timeout_fires_and_local_context_clears(pool: PgPool) {
    let restricted = crate::test_app_pool(pool).await;
    let app = PoolConfig::configured(Some("3"), None)
        .unwrap()
        .options()
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
