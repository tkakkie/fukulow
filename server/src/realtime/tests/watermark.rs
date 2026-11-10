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
    let status = if input.is_some() {
        "201 Created"
    } else {
        "200 OK"
    };
    http_status(address, token, channel, input, status).await
}

async fn http_status(
    address: std::net::SocketAddr,
    token: &str,
    channel: Uuid,
    input: Option<Value>,
    status: &str,
) -> Value {
    let method = if input.is_some() { "POST" } else { "GET" };
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
    let first_admission = tokio::time::Instant::now();
    for count in 1..=4 {
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

    // One send holds a connection; every other same-Channel send/retry waits outside
    // the pool. Preserve the admitted retry to check canonical recovery after COMMIT.
    let address = f.server.address;
    let token = f.token.clone();
    let stuck_channel = f.channel;
    let admitted_retry = tokio::spawn(async move {
        http_json(
            address,
            &token,
            stuck_channel,
            Some(json!({"client_message_id": key, "body": "unresolved"})),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%SELECT pg_advisory_xact_lock(%' AND $1 = ANY(pg_blocking_pids(pid))")
                .bind(pid).fetch_one(&pool).await.unwrap();
            if count == 1 { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();

    let barrier = Arc::new(tokio::sync::Barrier::new(97));
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
    for index in 0..32 {
        let token = f.token.clone();
        let barrier = barrier.clone();
        reconnecting.spawn(async move {
            barrier.wait().await;
            for attempt in 0..3 {
                let send_key = if index % 2 == 0 { key } else { Uuid::new_v4() };
                let body = if index % 2 == 0 {
                    "unresolved"
                } else {
                    "new send"
                };
                let response = tokio::time::timeout(
                    Duration::from_secs(2),
                    http_status(
                        address,
                        &token,
                        stuck_channel,
                        Some(json!({"client_message_id": send_key, "body": body})),
                        "500 Internal Server Error",
                    ),
                )
                .await
                .expect("send admission must reject without occupying a connection");
                assert_eq!(
                    response,
                    json!({"error": "internal error"}),
                    "attempt {attempt}"
                );
            }
        });
    }
    tokio::time::timeout(Duration::from_secs(5), barrier.wait())
        .await
        .expect("all storm clients must finish their authenticated handshakes");
    let probes = async {
        // Both another Channel and another Organization can still subscribe.
        for (token, channel) in [(&f.token, other_channel), (&other_token, foreign_channel)] {
            tokio::time::timeout(Duration::from_secs(2), async {
                let mut socket = connect(address, token).await;
                subscribe(&mut socket, channel, 0).await;
                ready(&mut socket, channel, 0).await;
            })
            .await
            .expect("a stuck Channel must not consume unrelated subscription slots");
        }
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
    assert!(
        first_admission.elapsed() < Duration::from_secs(8),
        "fault phase must finish within 8s since FIRST admission, before any 10s waiter deadline: {:?}",
        first_admission.elapsed()
    );
    assert_eq!(lock_waiters(&pool, pid).await, 4);
    // One unresolved COMMIT + four watermark waiters + one send; no storm work
    // may have acquired the remaining fourteen connections.
    assert!(
        app_pool.size() - app_pool.num_idle() as u32 <= 6,
        "storm occupied extra pool connections"
    );

    tx.commit().await.unwrap();
    let canonical = admitted_retry.await.unwrap();
    assert_eq!(canonical["client_message_id"], json!(key));
    assert_eq!(canonical["seq"], 1);
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

#[sqlx::test]
async fn simultaneous_normal_subscriptions_have_no_internal_error_closes(pool: PgPool) {
    let app_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let f = fixture(&app_pool).await;
    let mut channels = vec![f.channel];
    for _ in 0..31 {
        channels.push(channel(&pool, f.organization, f.member, false).await);
    }
    let barrier = Arc::new(tokio::sync::Barrier::new(513));
    // Bound TCP handshakes to avoid testing the OS listen backlog; all 512
    // authenticated sockets issue their subscriptions together below.
    let handshakes = Arc::new(Semaphore::new(32));
    let mut clients = tokio::task::JoinSet::new();
    for index in 0..512 {
        let address = f.server.address;
        let token = f.token.clone();
        // A popular Channel and a burst across many Channels exercise both caps.
        let channel = if index < 256 {
            f.channel
        } else {
            channels[index % channels.len()]
        };
        let barrier = barrier.clone();
        let handshakes = handshakes.clone();
        clients.spawn(async move {
            let permit = handshakes.acquire().await.unwrap();
            let mut socket = connect(address, &token).await;
            drop(permit);
            barrier.wait().await;
            subscribe(&mut socket, channel, 0).await;
            ready(&mut socket, channel, 0).await;
            (channel, socket)
        });
    }
    tokio::time::timeout(Duration::from_secs(10), barrier.wait())
        .await
        .unwrap();
    let mut connected = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(result) = clients.join_next().await {
            connected.push(result.unwrap());
        }
    })
    .await
    .expect("all 512 simultaneous subscriptions must be accepted without 1011");
    assert_eq!(connected.len(), 512);
    let mut canonical = HashMap::new();
    for channel in channels {
        canonical.insert(channel, post(&f, channel).await);
    }
    for (channel, socket) in &mut connected {
        assert_eq!(event(socket).await["message"], canonical[channel]);
    }
}
