use super::*;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

async fn http_send(
    address: std::net::SocketAddr,
    token: String,
    channel: Uuid,
    key: Uuid,
) -> Value {
    let mut socket = TcpStream::connect(address).await.unwrap();
    let body = json!({"client_message_id": key, "body": "shutdown send"}).to_string();
    let path = scoped_path(&format!("/api/v1/channels/{channel}/messages"), &token);
    socket.write_all(format!("POST {path} HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).await.unwrap();
    assert!(response.starts_with("HTTP/1.1 201"), "{response}");
    serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap()
}

async fn signal_process(pool: PgPool, expired: bool, signal: &str) {
    use sqlx::ConnectOptions;
    let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "realtime::tests::shutdown::signal_child",
            "--ignored",
            "--nocapture",
        ])
        .env(
            "SHUTDOWN_TEST_DATABASE",
            pool.connect_options().to_url_lossy().as_str(),
        )
        .env("SHUTDOWN_TEST_EXPIRED", if expired { "1" } else { "0" })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let line = lines
                .next_line()
                .await
                .unwrap()
                .expect("child exited before signal readiness");
            if line == "READY_FOR_SIGNAL" {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(
        tokio::process::Command::new("kill")
            .args([signal, &child.id().unwrap().to_string()])
            .status()
            .await
            .unwrap()
            .success()
    );
    let status = tokio::time::timeout(Duration::from_secs(15), child.wait())
        .await
        .unwrap()
        .unwrap();
    let mut output = String::new();
    while let Some(line) = lines.next_line().await.unwrap() {
        output.push_str(&line);
        output.push('\n');
    }
    assert!(status.success(), "signal child failed: {output}");
}

#[sqlx::test]
async fn sigterm_drains_http_persistence_and_detached_notification_then_replays_without_duplicates(
    pool: PgPool,
) {
    signal_process(pool, false, "-TERM").await;
}

#[sqlx::test]
async fn sigterm_drain_deadline_expires_without_closing_pool_under_unfinished_work(pool: PgPool) {
    signal_process(pool, true, "-TERM").await;
}

#[sqlx::test]
async fn sigint_drains_and_closes_idle_sockets_normally(pool: PgPool) {
    signal_process(pool, false, "-INT").await;
}

#[sqlx::test]
async fn disconnected_http_send_stays_in_drain_until_persistence_and_notification_finish(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let key = Uuid::new_v4();
    let persistence = messages::pause_commit(key);
    let notification = messages::pause_publication(key);
    let app = f.app.clone();
    let token = f.token.clone();
    let channel = f.channel;
    let request = tokio::spawn(async move {
        super::request(
            &app,
            "POST",
            &format!("/api/v1/channels/{channel}/messages"),
            &token,
            json!({"client_message_id": key, "body": "caller gone"}),
        )
        .await
    });
    super::notification::publication_entered(&persistence).await;
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    let delivery = f.state.message_delivery.clone();
    let drain = tokio::spawn(async move { delivery.drained().await });
    assert!(!drain.is_finished());
    persistence.release.add_permits(1);
    super::notification::publication_entered(&notification).await;
    assert!(!drain.is_finished());
    notification.release.add_permits(1);
    tokio::time::timeout(Duration::from_secs(5), drain)
        .await
        .unwrap()
        .unwrap();
    let mut replay = f.server.connect(&f.token).await;
    subscribe(&mut replay, f.channel, 0).await;
    assert_eq!(
        event(&mut replay).await["message"]["client_message_id"],
        key.to_string()
    );
    ready(&mut replay, f.channel, 1).await;
}

#[tokio::test]
#[ignore = "subprocess helper: parent sends a real signal after all three work kinds exist"]
async fn signal_child() {
    let url = std::env::var("SHUTDOWN_TEST_DATABASE").unwrap();
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect(&url)
        .await
        .unwrap();
    let mut f = fixture(&pool).await;
    let fatal = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let calls = fatal.clone();
    f.state.session_changes = Default::default();
    f.state.session_changes = f.state.session_changes.with_on_fatal(Arc::new(move || {
        calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let expired = std::env::var("SHUTDOWN_TEST_EXPIRED").unwrap() == "1";
    let deadline = if expired {
        Duration::from_millis(150)
    } else {
        Duration::from_secs(5)
    };
    let signal = crate::shutdown::signal().unwrap();
    let serving = tokio::spawn(crate::shutdown::serve(
        listener,
        f.state.clone(),
        signal,
        deadline,
    ));
    let server = Server {
        address,
        task: tokio::spawn(std::future::pending()),
    };
    let mut idle = server.connect(&f.token).await;
    let mut subscribed = server.connect(&f.token).await;
    subscribe(&mut subscribed, f.channel, 0).await;
    ready(&mut subscribed, f.channel, 0).await;

    let first_key = Uuid::new_v4();
    let notification = messages::pause_publication(first_key);
    let first = http_send(address, f.token.clone(), f.channel, first_key).await;
    super::notification::publication_entered(&notification).await;
    let key = Uuid::new_v4();
    let persistence = messages::pause_commit(key);
    let pending = tokio::spawn(http_send(address, f.token.clone(), f.channel, key));
    super::notification::publication_entered(&persistence).await;
    println!("READY_FOR_SIGNAL");
    f.state.shutdown.cancelled().await;
    let start = std::time::Instant::now();
    closed(&mut idle, 1001).await;
    closed(&mut subscribed, 1001).await;
    assert!(!pool.is_closed());
    assert!(!serving.is_finished());
    assert!(!pending.is_finished());
    // Requests on an already built Router are rejected too (keep-alive race).
    let response = request(
        &crate::app(f.state.clone()),
        "GET",
        "/api/v1/health",
        &f.token,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    tokio::task::yield_now().await;
    assert!(TcpStream::connect(address).await.is_err());

    if expired {
        assert!(!serving.await.unwrap().unwrap());
        assert!(start.elapsed() < Duration::from_secs(2));
        assert!(!pool.is_closed());
    } else {
        persistence.release.add_permits(1);
        let second = pending.await.unwrap();
        assert_eq!(second["seq"], 2);
        assert!(
            !serving.is_finished(),
            "HTTP drained but notification is still held"
        );
        assert!(!pool.is_closed());
        notification.release.add_permits(1);
        assert!(serving.await.unwrap().unwrap());
        assert!(pool.is_closed());
        assert!(start.elapsed() < deadline);
        tokio::time::sleep(Duration::from_millis(2100)).await;
        assert_eq!(fatal.load(std::sync::atomic::Ordering::SeqCst), 0);

        let restarted_pool = sqlx::postgres::PgPoolOptions::new()
            .connect(&url)
            .await
            .unwrap();
        f.state = state(&restarted_pool);
        f.app = crate::app(f.state.clone());
        let restarted = Server::start(f.app.clone()).await;
        assert_eq!(
            send(&f, &f.token, f.channel, first_key, "shutdown send").await,
            first
        );
        assert_eq!(
            send(&f, &f.token, f.channel, key, "shutdown send").await,
            second
        );
        let mut replay = restarted.connect(&f.token).await;
        subscribe(&mut replay, f.channel, 0).await;
        assert_eq!(event(&mut replay).await["message"], first);
        assert_eq!(event(&mut replay).await["message"], second);
        ready(&mut replay, f.channel, 2).await;
        f.state.shutdown.begin();
        closed(&mut replay, 1001).await;
        restarted_pool.close().await;
        return;
    }
    persistence.release.add_permits(1);
    pending.await.unwrap();
    notification.release.add_permits(1);
    f.state.message_delivery.drained().await;
    pool.close().await;
}
