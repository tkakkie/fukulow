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
        .fetch_one(tx.connection().unwrap())
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

    // The unresolved send owns admission; every same-Channel send/retry waits outside
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
    tokio::task::yield_now().await;
    assert!(!admitted_retry.is_finished());

    let barrier = Arc::new(tokio::sync::Barrier::new(161));
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
                // An uncapped database lock wait cannot meet this bound.
                tokio::time::timeout(Duration::from_secs(2), async {
                    subscribe(&mut socket, channel, 0).await;
                    closed(&mut socket, 1011).await;
                })
                .await
                .expect("watermark saturation must close after bounded admission");
                if attempt < 2 {
                    socket = connect(address, &token).await;
                }
            }
        });
    }
    let mut sending = tokio::task::JoinSet::new();
    for index in 0..96 {
        let token = f.token.clone();
        let barrier = barrier.clone();
        sending.spawn(async move {
            barrier.wait().await;
            let send_key = if index % 2 == 0 { key } else { Uuid::new_v4() };
            let body = if index % 2 == 0 {
                "unresolved"
            } else {
                "new send"
            };
            http_json(
                address,
                &token,
                stuck_channel,
                Some(json!({"client_message_id": send_key, "body": body})),
            )
            .await
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
    assert!(
        sending.try_join_next().is_none(),
        "send waiters must remain queued until COMMIT resolves"
    );
    // One unresolved COMMIT + four watermark waiters; no storm work
    // may have acquired the remaining fourteen connections.
    assert!(
        app_pool.size() - app_pool.num_idle() as u32 <= 5,
        "storm occupied extra pool connections"
    );

    tx.commit().await.unwrap();
    let canonical = admitted_retry.await.unwrap();
    assert_eq!(canonical["client_message_id"], json!(key));
    assert_eq!(canonical["seq"], 1);
    let mut seqs = std::collections::BTreeSet::from([1]);
    while let Some(result) = sending.join_next().await {
        let message = result.unwrap();
        if message["client_message_id"] == json!(key) {
            assert_eq!(message, canonical);
        } else {
            assert!(seqs.insert(message["seq"].as_i64().unwrap()));
        }
    }
    assert_eq!(
        seqs.into_iter().collect::<Vec<_>>(),
        (1..=49).collect::<Vec<_>>()
    );
    for socket in &mut waiting {
        // COMMIT resolution can race the queued sends and the handoff snapshot.
        let mut seq = 0;
        let mut subscribed = false;
        while seq < 49 || !subscribed {
            let value = event(socket).await;
            if value["type"] == "subscribed" {
                assert!(!subscribed);
                assert_eq!(value["caught_up_seq"], seq);
                subscribed = true;
            } else {
                seq += 1;
                assert_eq!(value["message"]["seq"], seq);
                if seq == 1 {
                    assert_eq!(value["message"], canonical);
                }
            }
        }
    }
    let mut recovered = f.server.connect(&f.token).await;
    subscribe(&mut recovered, f.channel, 0).await;
    for seq in 1..=49 {
        let value = event(&mut recovered).await;
        assert_eq!(value["message"]["seq"], seq);
        if seq == 1 {
            assert_eq!(value["message"], canonical);
        }
    }
    ready(&mut recovered, f.channel, 49).await;
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
        // Four popular Channels exercise repeated cap handoffs with more scheduling
        // margin than 264 reads serialized four at a time under the 1s deadline.
        let channel = if index < 256 {
            channels[index % 4]
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

#[sqlx::test]
async fn repeated_send_deadlines_abandon_connections_and_preserve_other_organization_progress(
    pool: PgPool,
) {
    let app_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let f = fixture(&app_pool).await;
    let foreign_org = organization(&pool).await;
    let (foreign_member, foreign_token) = member(&pool, foreign_org).await;
    let foreign_channel = channel(&pool, foreign_org, foreign_member, false).await;
    let mut before = f.server.connect(&f.token).await;
    subscribe(&mut before, f.channel, 0).await;
    ready(&mut before, f.channel, 0).await;
    let mut blocker = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(158::bigint)")
        .execute(&mut *blocker)
        .await
        .unwrap();
    // Disable only this injected COMMIT's lock timeout, so a backend really stays
    // unresolved across several response deadlines even after its socket is gone.
    sqlx::raw_sql(&format!(
        "CREATE FUNCTION hold_commit() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN IF NEW.channel_id = '{}'::uuid THEN \
         PERFORM set_config('lock_timeout', '0', true); \
         PERFORM pg_advisory_xact_lock(158::bigint); END IF; RETURN NEW; END $$; \
         CREATE CONSTRAINT TRIGGER hold_commit AFTER INSERT ON messages \
         DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hold_commit();",
        f.channel,
    ))
    .execute(&pool)
    .await
    .unwrap();
    let key = Uuid::new_v4();
    let address = f.server.address;
    let channel = f.channel;
    let started = tokio::time::Instant::now();
    let mut peak_held = 0;
    for round in 0..3 {
        let token = f.token.clone();
        let sending = tokio::spawn(async move {
            http_status(
                address,
                &token,
                channel,
                Some(json!({"client_message_id": key, "body": "held commit"})),
                "500 Internal Server Error",
            )
            .await
        });
        // Keep probing for the whole deadline, rather than only before 10 s.
        for tick in 0..11 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            tokio::time::timeout(Duration::from_secs(2), async {
                let sent = http_json(
                    address,
                    &foreign_token,
                    foreign_channel,
                    Some(json!({"client_message_id": Uuid::new_v4(), "body": "independent"})),
                )
                .await;
                let seq = round * 11 + tick + 1;
                assert_eq!(sent["seq"], seq);
                let page = http_json(address, &foreign_token, foreign_channel, None).await;
                assert_eq!(page["messages"][seq as usize - 1], sent);
                let mut socket = connect(address, &foreign_token).await;
                subscribe(&mut socket, foreign_channel, seq).await;
                ready(&mut socket, foreign_channel, seq).await;
            })
            .await
            .expect("another Organization's HTTP reads/writes/subscriptions must keep working");
            // Pool returns include an asynchronous readiness check; wait only for
            // that cleanup, never for the stuck transaction to finish.
            tokio::time::timeout(Duration::from_millis(500), async {
                while app_pool.size() - app_pool.num_idle() as u32 > 1 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("timed-out work retained pool connections");
            let held = app_pool.size() - app_pool.num_idle() as u32;
            peak_held = peak_held.max(held);
            assert!(
                held <= 1,
                "timed-out work retained pool connections: {held}"
            );
        }
        tokio::time::timeout(Duration::from_secs(2), sending)
            .await
            .unwrap()
            .unwrap();
        if round == 0 {
            closed(&mut before, 1011).await;
        }
    }
    assert!(started.elapsed() >= Duration::from_secs(33));
    assert_eq!(peak_held, 1);
    // A local socket close need not decide the server-side COMMIT. Recovery still
    // uses #135's barrier and canonical key, whether it committed or rolled back.
    blocker.commit().await.unwrap();
    let canonical = http_json(
        address,
        &f.token,
        channel,
        Some(json!({"client_message_id": key, "body": "held commit"})),
    )
    .await;
    assert_eq!(canonical["seq"], 1);
    assert_eq!(
        http_json(
            address,
            &f.token,
            channel,
            Some(json!({"client_message_id": key, "body": "held commit"}))
        )
        .await,
        canonical
    );
    let next = http_json(
        address,
        &f.token,
        channel,
        Some(json!({"client_message_id": Uuid::new_v4(), "body": "next"})),
    )
    .await;
    assert_eq!(next["seq"], 2);
    let mut recovered = connect(address, &f.token).await;
    subscribe(&mut recovered, channel, 0).await;
    assert_eq!(event(&mut recovered).await["message"], canonical);
    assert_eq!(event(&mut recovered).await["message"], next);
    ready(&mut recovered, channel, 2).await;
    drop(recovered);
    drop(before);
    drop(f);
    app_pool.close().await;
}

#[sqlx::test]
async fn sixteen_concurrent_sends_leave_reserved_capacity_for_new_subscription(pool: PgPool) {
    let app_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let f = fixture(&app_pool).await;
    let foreign_org = organization(&pool).await;
    let (foreign_member, foreign_token) = member(&pool, foreign_org).await;
    let foreign_channel = channel(&pool, foreign_org, foreign_member, false).await;
    let mut channels = Vec::new();
    for _ in 0..16 {
        channels.push(channel(&pool, f.organization, f.member, false).await);
    }
    // A finite 3 s COMMIT delay represents ordinary slow work, below the 10 s
    // work deadline but above watermark admission's 1 s. All sends must succeed.
    sqlx::raw_sql(
        "CREATE FUNCTION slow_send() RETURNS trigger LANGUAGE plpgsql AS $$ \
        BEGIN PERFORM pg_sleep(3); RETURN NEW; END $$; \
        CREATE CONSTRAINT TRIGGER slow_send AFTER INSERT ON messages \
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION slow_send();",
    )
    .execute(&pool)
    .await
    .unwrap();
    let mut socket = connect(f.server.address, &foreign_token).await;
    let barrier = Arc::new(tokio::sync::Barrier::new(17));
    let mut sends = tokio::task::JoinSet::new();
    for channel in channels {
        let address = f.server.address;
        let token = f.token.clone();
        let barrier = barrier.clone();
        sends.spawn(async move {
            barrier.wait().await;
            http_json(
                address,
                &token,
                channel,
                Some(json!({"client_message_id": Uuid::new_v4(), "body": "normal send"})),
            )
            .await
        });
    }
    barrier.wait().await;
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let committing: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() \
                 AND query = 'COMMIT' AND wait_event = 'PgSleep'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            if committing >= 8 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(sends.try_join_next().is_none());
    // With the former shared budget all 16 slots stay occupied for >1 s,
    // so this subscription closes with 1011 instead of confirming.
    tokio::time::timeout(Duration::from_secs(1), async {
        subscribe(&mut socket, foreign_channel, 0).await;
        ready(&mut socket, foreign_channel, 0).await;
    })
    .await
    .expect("sends must leave reserved watermark capacity");
    let mut completed = 0;
    while let Some(result) = sends.join_next().await {
        assert_eq!(result.unwrap()["seq"], 1);
        completed += 1;
    }
    assert_eq!(completed, 16);
    drop(socket);
    drop(f);
    app_pool.close().await;
}
