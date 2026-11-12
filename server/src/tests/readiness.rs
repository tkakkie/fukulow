use super::*;
use axum::body::to_bytes;
use sqlx::{PgPool, postgres::PgPoolOptions};

async fn request(router: &Router, path: &str) -> Response {
    router
        .clone()
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn assert_ready(router: &Router) {
    let response = request(router, "/api/v1/ready").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(to_bytes(response.into_body(), 1024).await.unwrap(), "ok");
}

async fn assert_not_ready(router: &Router) {
    let response = request(router, "/api/v1/ready").await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({"error": "not_ready"})
    );
}

#[sqlx::test(migrations = false)]
async fn readiness_accepts_not_started_worker(pool: PgPool) {
    let router = app(AppState::for_test(pool));
    assert_ready(&router).await;
}

#[sqlx::test(migrations = false)]
async fn readiness_acquire_timeout_recovers_without_changing_liveness(pool: PgPool) {
    let single = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    let router = app(AppState::for_test(single.clone()));
    assert_ready(&router).await;
    let connection = single.acquire().await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), assert_not_ready(&router))
        .await
        .expect("readiness must bound pool acquisition");
    let live = request(&router, "/api/v1/health").await;
    assert_eq!(live.status(), StatusCode::OK);
    assert_eq!(to_bytes(live.into_body(), 1024).await.unwrap(), "ok");
    drop(connection);
    assert_ready(&router).await;
    single.close().await;
    assert_not_ready(&router).await;
}

#[sqlx::test(migrations = false)]
async fn readiness_query_timeout_releases_slot_limits_flood_and_recovers(pool: PgPool) {
    use sqlx::postgres::PgSslMode;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::{Notify, watch},
        task::JoinSet,
    };

    tokio::time::timeout(Duration::from_secs(10), async {
        let options = pool.connect_options();
        let upstream = (options.get_host().to_owned(), options.get_port());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (hold, gate) = watch::channel(false);
        let blocked = std::sync::Arc::new(Notify::new());
        let observed = blocked.clone();
        let mut relays = JoinSet::new();
        relays.spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                let (mut client, _) = listener.accept().await.unwrap();
                let mut server = TcpStream::connect((upstream.0.as_str(), upstream.1))
                    .await
                    .unwrap();
                let mut gate = gate.clone();
                let observed = observed.clone();
                connections.spawn(async move {
                    let (mut client_read, mut client_write) = client.split();
                    let (mut server_read, mut server_write) = server.split();
                    let requests = tokio::io::copy(&mut client_read, &mut server_write);
                    let responses = async {
                        let mut bytes = [0; 8192];
                        loop {
                            let count = server_read.read(&mut bytes).await?;
                            if count == 0 {
                                return Ok::<_, std::io::Error>(());
                            }
                            while *gate.borrow_and_update() {
                                observed.notify_one();
                                if gate.changed().await.is_err() {
                                    return Ok(());
                                }
                            }
                            client_write.write_all(&bytes[..count]).await?;
                        }
                    };
                    tokio::select! { _ = requests => {}, _ = responses => {} }
                });
                while connections.try_join_next().is_some() {}
            }
        });
        let single = PgPoolOptions::new()
            .max_connections(1)
            .test_before_acquire(false)
            .connect_with(
                options
                    .as_ref()
                    .clone()
                    .host("127.0.0.1")
                    .port(address.port())
                    .ssl_mode(PgSslMode::Disable),
            )
            .await
            .unwrap();
        let router = app(AppState::for_test(single.clone()));
        assert_ready(&router).await;
        let mut connection = single.acquire().await.unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
        connection.return_to_pool().await;
        drop(connection);
        hold.send(true).unwrap();
        let check = tokio::spawn({
            let router = router.clone();
            async move { assert_not_ready(&router).await }
        });
        blocked.notified().await;
        // Concurrent public probes must not queue more pool acquisitions behind this one.
        tokio::time::timeout(Duration::from_millis(100), assert_not_ready(&router))
            .await
            .expect("concurrent readiness must reject immediately");
        check.await.unwrap();
        assert_eq!(
            single.size(),
            0,
            "query timeout must immediately release the pool slot"
        );
        hold.send(false).unwrap();
        assert_ready(&router).await;
        let new_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&single)
            .await
            .unwrap();
        assert_ne!(pid, new_pid, "timed-out socket must be discarded");
        single.close().await;
        drop(relays);
    })
    .await
    .expect("readiness query timeout and recovery must not hang");
}
