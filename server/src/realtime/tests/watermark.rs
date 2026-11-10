use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn connect(address: std::net::SocketAddr, token: &str) -> Client {
    let mut request = format!("ws://{address}/api/v1/ws")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    tokio_tungstenite::connect_async(request).await.unwrap().0
}

async fn lock_waiters(pool: &PgPool, holder: i32) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM pg_locks waiter JOIN pg_locks holder \
         USING (locktype, database, classid, objid, objsubid) \
         WHERE holder.pid = $1 AND holder.granted AND waiter.mode = 'ShareLock' \
         AND NOT waiter.granted AND waiter.locktype = 'advisory'",
    )
    .bind(holder)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn http_json(
    address: std::net::SocketAddr,
    token: &str,
    channel: Uuid,
    input: Option<Value>,
) -> Value {
    let (method, status) = if input.is_some() {
        ("POST", "201 Created")
    } else {
        ("GET", "200 OK")
    };
    let body = input.map(|value| value.to_string()).unwrap_or_default();
    let mut stream = TcpStream::connect(address).await.unwrap();
    stream
        .write_all(
            format!(
                "{method} /api/v1/channels/{channel}/messages HTTP/1.1\r\nHost: {address}\r\n\
                 Authorization: Bearer {token}\r\nContent-Type: application/json\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    assert!(
        response.starts_with(&format!("HTTP/1.1 {status}\r\n")),
        "{response}"
    );
    serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap()
}

#[sqlx::test]
async fn unresolved_commit_reconnect_storm_leaves_pool_headroom_for_other_organizations_and_channels(
    pool: PgPool,
) {
    // Match the production pool; the SQLx fixture pool observes locks independently.
    let app_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let f = fixture(&app_pool).await;
    let other_channel = channel(&pool, f.organization, f.member, false).await;
    let other_org = organization(&pool).await;
    let (other_member, other_token) = member(&pool, other_org).await;
    let foreign_channel = channel(&pool, other_org, other_member, false).await;
    let key = Uuid::new_v4();
    let pending = messages::ambiguous_commit(key);
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/channels/{}/messages", f.channel),
        &f.token,
        json!({"client_message_id": key, "body": "unresolved"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let mut tx = pending.await.unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *tx)
        .await
        .unwrap();

    let mut waiting = Vec::new();
    for count in 1..=16 {
        let mut socket = f.server.connect(&f.token).await;
        subscribe(&mut socket, f.channel, 0).await;
        tokio::time::timeout(Duration::from_secs(2), async {
            while lock_waiters(&pool, pid).await != count {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        waiting.push(socket);
    }

    let barrier = Arc::new(tokio::sync::Barrier::new(65));
    let mut reconnecting = tokio::task::JoinSet::new();
    for _ in 0..64 {
        let address = f.server.address;
        let token = f.token.clone();
        let channel = f.channel;
        let barrier = barrier.clone();
        reconnecting.spawn(async move {
            let mut socket = connect(address, &token).await;
            barrier.wait().await;
            for attempt in 0..3 {
                // A queued permit or an uncapped lock wait cannot meet this bound.
                tokio::time::timeout(Duration::from_secs(2), async {
                    subscribe(&mut socket, channel, 0).await;
                    closed(&mut socket, 1011).await;
                })
                .await
                .expect("saturation must close immediately, without queuing");
                if attempt < 2 {
                    socket = connect(address, &token).await;
                }
            }
        });
    }
    tokio::time::timeout(Duration::from_secs(5), barrier.wait())
        .await
        .expect("all storm clients must finish their authenticated handshakes");
    let probes = async {
        for seq in 1..=10 {
            for (token, channel) in [(&f.token, other_channel), (&other_token, foreign_channel)] {
                tokio::time::timeout(Duration::from_secs(2), async {
                    let sent = http_json(
                        f.server.address,
                        token,
                        channel,
                        Some(json!({"client_message_id": Uuid::new_v4(), "body": "headroom"})),
                    )
                    .await;
                    assert_eq!(sent["seq"], seq);
                    let page = http_json(f.server.address, token, channel, None).await;
                    assert_eq!(page["messages"].as_array().unwrap().len(), seq as usize);
                    assert_eq!(page["messages"][seq as usize - 1], sent);
                })
                .await
                .expect("unrelated HTTP read/write must obtain a pool connection within 2s");
            }
        }
    };
    let storm = async {
        while let Some(result) = reconnecting.join_next().await {
            result.unwrap();
        }
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(probes, storm)
    })
    .await
    .expect("load/fault phase must finish before the 10s watermark deadline");
    assert_eq!(lock_waiters(&pool, pid).await, 16);

    tx.commit().await.unwrap();
    for socket in &mut waiting {
        let message = event(socket).await;
        assert_eq!(message["message"]["client_message_id"], json!(key));
        assert_eq!(message["message"]["seq"], 1);
        ready(socket, f.channel, 1).await;
    }
    let mut recovered = f.server.connect(&f.token).await;
    subscribe(&mut recovered, f.channel, 0).await;
    assert_eq!(
        event(&mut recovered).await["message"]["client_message_id"],
        json!(key)
    );
    ready(&mut recovered, f.channel, 1).await;
}
