use super::*;

// Manual before/after probe; includes the idle loopback clients in process CPU/RSS.
#[sqlx::test]
#[ignore = "manual release-mode socket CPU/RSS and notification-failure latency measurement"]
async fn measure_idle_sockets_and_notification_failure_latency(pool: PgPool) {
    let count: usize = std::env::var("MEASURE_SOCKETS")
        .unwrap_or_else(|_| "10000".into())
        .parse()
        .unwrap();
    let subscriptions: usize = std::env::var("MEASURE_SUBSCRIPTIONS")
        .unwrap_or_else(|_| "10".into())
        .parse()
        .unwrap();
    assert!((1..=256).contains(&subscriptions));
    let f = fixture(&pool).await;
    let mut channels = vec![f.channel];
    for _ in 1..subscriptions {
        channels.push(channel(&pool, f.organization, f.member, false).await);
    }
    let mut clients = tokio::task::JoinSet::new();
    let started = Arc::new(std::sync::OnceLock::<std::time::Instant>::new());
    for index in 0..count {
        let mut socket = f.server.connect(&f.token).await;
        for &channel in &channels {
            subscribe(&mut socket, channel, 0).await;
            ready(&mut socket, channel, 0).await;
        }
        let started = started.clone();
        clients.spawn(async move {
            while let Some(frame) = socket.next().await {
                match frame.unwrap() {
                    tungstenite::Message::Ping(_) => socket.flush().await.unwrap(),
                    tungstenite::Message::Close(Some(close)) => {
                        assert_eq!(
                            close.code,
                            tungstenite::protocol::frame::coding::CloseCode::Error
                        );
                        return started.get().unwrap().elapsed().as_secs_f64() * 1000.0;
                    }
                    frame => panic!("unexpected measurement frame: {frame:?}"),
                }
            }
            panic!("measurement socket ended without 1011");
        });
        if (index + 1).is_multiple_of(1000) {
            eprintln!("prepared {} sockets", index + 1);
        }
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    eprintln!(
        "MEASURE_IDLE_START pid={} sockets={count} subscriptions={subscriptions}",
        std::process::id()
    );
    let idle = std::time::Instant::now();
    tokio::time::sleep(Duration::from_secs(20)).await;
    let elapsed = idle.elapsed().as_secs_f64();
    eprintln!("MEASURE_IDLE_END idle_seconds={elapsed:.3}");
    let mut gates = Vec::new();
    for _ in 0..messages::MAX_IN_FLIGHT_NOTIFICATIONS {
        let key = Uuid::new_v4();
        let gate = messages::pause_publication(key);
        send(&f, &f.token, f.channel, key, "held measurement").await;
        publication_entered(&gate).await;
        gates.push(gate);
    }
    started.set(std::time::Instant::now()).unwrap();
    send(
        &f,
        &f.token,
        f.channel,
        Uuid::new_v4(),
        "saturated measurement",
    )
    .await;
    let mut latency = Vec::new();
    tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(result) = clients.join_next().await {
            latency.push(result.unwrap());
        }
    })
    .await
    .unwrap();
    latency.sort_by(f64::total_cmp);
    eprintln!(
        "MEASURE 1011_ms_from_saturated_send_start min={:.3} median={:.3} p95={:.3} max={:.3}",
        latency[0],
        latency[count / 2],
        latency[count * 95 / 100],
        latency[count - 1]
    );
    for gate in gates {
        gate.release.add_permits(1);
    }
    f.state.message_delivery.flush().await;
}

async fn publication_entered(gate: &messages::PublicationGate) {
    tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
}

#[sqlx::test]
async fn http_response_does_not_wait_for_notification_and_concurrent_sends_recover_order(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let mut socket = f.server.connect(&f.token).await;
    subscribe(&mut socket, f.channel, 0).await;
    ready(&mut socket, f.channel, 0).await;
    let key = Uuid::new_v4();
    let gate = messages::pause_publication(key);
    let first = tokio::time::timeout(
        Duration::from_secs(5),
        send(&f, &f.token, f.channel, key, "notification held"),
    )
    .await
    .unwrap();
    publication_entered(&gate).await;
    assert_eq!(first["seq"], 1);
    let history = messages::replay_page(&pool, f.organization, f.channel, 0, 1)
        .await
        .unwrap();
    assert_eq!(json!(history[0]), first);

    let mut sends = tokio::task::JoinSet::new();
    for _ in 0..16 {
        let app = f.app.clone();
        let token = f.token.clone();
        let channel = f.channel;
        sends.spawn(async move {
            request(
                &app,
                "POST",
                &format!("/api/v1/channels/{channel}/messages"),
                &token,
                json!({"client_message_id":Uuid::new_v4(),"body":"concurrent"}),
            )
            .await
        });
    }
    for seq in 1..=17 {
        assert_eq!(event(&mut socket).await["message"]["seq"], seq);
    }
    while let Some(result) = sends.join_next().await {
        assert_eq!(result.unwrap().status(), StatusCode::CREATED);
    }
    gate.release.add_permits(1);
    f.state.message_delivery.flush().await;
    let next = post(&f, f.channel).await;
    assert_eq!(event(&mut socket).await["message"], next);
    f.state.message_delivery.flush().await;
    silent(&mut socket).await;
}

#[sqlx::test]
async fn saturated_notifications_close_only_affected_sockets_and_reconnect_replays(pool: PgPool) {
    let f = fixture(&pool).await;
    let other_channel = channel(&pool, f.organization, f.member, false).await;
    let foreign = fixture(&pool).await;
    // The same Channel UUID in another Organization, on the same Delivery registry.
    sqlx::query("INSERT INTO channels (organization_id, id, name, visibility) VALUES ($1, $2, 'Foreign', 'public')")
        .bind(foreign.organization).bind(f.channel).execute(&pool).await.unwrap();
    let mut affected = Vec::new();
    for _ in 0..256 {
        let mut socket = f.server.connect(&f.token).await;
        subscribe(&mut socket, f.channel, 0).await;
        ready(&mut socket, f.channel, 0).await;
        affected.push(socket);
    }
    let mut unrelated = f.server.connect(&f.token).await;
    subscribe(&mut unrelated, other_channel, 0).await;
    ready(&mut unrelated, other_channel, 0).await;
    let mut other_org = f.server.connect(&foreign.token).await;
    subscribe(&mut other_org, f.channel, 0).await;
    ready(&mut other_org, f.channel, 0).await;

    let mut gates = Vec::new();
    let mut committed = Vec::new();
    for _ in 0..messages::MAX_IN_FLIGHT_NOTIFICATIONS {
        let key = Uuid::new_v4();
        let gate = messages::pause_publication(key);
        committed.push(send(&f, &f.token, f.channel, key, "held notification").await);
        publication_entered(&gate).await;
        gates.push(gate);
    }
    // All slots are occupied, but there is no failure or HTTP backpressure yet.
    silent(&mut affected[0]).await;
    let key = Uuid::new_v4();
    committed.push(
        tokio::time::timeout(
            Duration::from_secs(5),
            send(&f, &f.token, f.channel, key, "saturated notification"),
        )
        .await
        .unwrap(),
    );
    for socket in &mut affected {
        closed(socket, 1011).await;
    }
    silent(&mut unrelated).await;
    silent(&mut other_org).await;

    let mut reconnect = f.server.connect(&f.token).await;
    subscribe(&mut reconnect, f.channel, 0).await;
    for message in &committed {
        assert_eq!(event(&mut reconnect).await["message"], *message);
    }
    ready(&mut reconnect, f.channel, committed.len() as i64).await;
    for gate in gates {
        gate.release.add_permits(1);
    }
    f.state.message_delivery.flush().await;
    let next = post(&f, f.channel).await;
    assert_eq!(event(&mut reconnect).await["message"], next);
    let own = post(&f, other_channel).await;
    assert_eq!(event(&mut unrelated).await["message"], own);
    let own = send(&f, &foreign.token, f.channel, Uuid::new_v4(), "foreign").await;
    assert_eq!(event(&mut other_org).await["message"], own);
    f.state.message_delivery.flush().await;
}

#[sqlx::test]
async fn saturated_http_response_with_many_subscribers_never_takes_recipients_lock(pool: PgPool) {
    let f = fixture(&pool).await;
    let mut queues = Vec::new();
    for _ in 0..512 {
        let mut queue = f
            .state
            .message_delivery
            .queue(f.organization, (f.member, 0), 1);
        queue.subscribe(f.channel);
        queues.push(queue);
    }
    let mut gates = Vec::new();
    for _ in 0..messages::MAX_IN_FLIGHT_NOTIFICATIONS {
        let key = Uuid::new_v4();
        let gate = messages::pause_publication(key);
        send(&f, &f.token, f.channel, key, "held").await;
        publication_entered(&gate).await;
        gates.push(gate);
    }
    let delivery = f.state.message_delivery.clone();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let held = tokio::task::spawn_blocking(move || {
        delivery.with_recipients_locked(|| {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(15)).unwrap();
        });
    });
    tokio::time::timeout(Duration::from_secs(5), entered_rx)
        .await
        .unwrap()
        .unwrap();
    let started = std::time::Instant::now();
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        send(&f, &f.token, f.channel, Uuid::new_v4(), "saturated"),
    )
    .await;
    let elapsed = started.elapsed();
    // Release even on a regression so the assertion cannot deadlock the runtime.
    release_tx.send(()).unwrap();
    held.await.unwrap();
    assert_eq!(response.unwrap()["seq"], 41);
    // This is a deadlock guard, not a real-database latency requirement.
    eprintln!("saturated HTTP with 512 subscribers and recipients locked: {elapsed:?}");
    for queue in &queues {
        assert!(queue.notification_failed.is_failed());
        assert!(!*queue.overflow.borrow());
    }
    for gate in gates {
        gate.release.add_permits(1);
    }
    f.state.message_delivery.flush().await;
}

#[sqlx::test]
async fn interrupted_or_timed_out_notification_closes_affected_sockets_and_reconnect_replays(
    pool: PgPool,
) {
    for failure in ["abort", "panic", "timeout"] {
        let f = fixture(&pool).await;
        let other_channel = channel(&pool, f.organization, f.member, false).await;
        let foreign = fixture(&pool).await;
        let mut live = f.server.connect(&f.token).await;
        subscribe(&mut live, f.channel, 0).await;
        ready(&mut live, f.channel, 0).await;
        let mut replaying = f.server.connect(&f.token).await;
        let replay_gate = pause(f.channel);
        subscribe(&mut replaying, f.channel, 0).await;
        entered(&replay_gate).await;
        let mut unrelated = f.server.connect(&f.token).await;
        subscribe(&mut unrelated, other_channel, 0).await;
        ready(&mut unrelated, other_channel, 0).await;
        let mut other_org = foreign.server.connect(&foreign.token).await;
        subscribe(&mut other_org, foreign.channel, 0).await;
        ready(&mut other_org, foreign.channel, 0).await;

        let key = Uuid::new_v4();
        let gate = messages::pause_publication(key);
        let committed = send(&f, &f.token, f.channel, key, "response before failure").await;
        publication_entered(&gate).await;
        match failure {
            "abort" => gate.task.lock().unwrap().as_ref().unwrap().abort(),
            "timeout" => {
                tokio::time::pause();
                tokio::time::advance(messages::NOTIFICATION_TIMEOUT).await;
                tokio::time::resume();
            }
            // Fail inside the notification future, rather than the HTTP worker.
            _ => gate.release.close(),
        }
        // No later publication is needed to expose this missing notification.
        closed(&mut live, 1011).await;
        closed(&mut replaying, 1011).await;
        f.state.message_delivery.flush().await;

        let mut reconnect = f.server.connect(&f.token).await;
        subscribe(&mut reconnect, f.channel, 0).await;
        assert_eq!(event(&mut reconnect).await["message"], committed);
        ready(&mut reconnect, f.channel, 1).await;
        let next = post(&f, f.channel).await;
        assert_eq!(event(&mut reconnect).await["message"], next);
        let own = post(&f, other_channel).await;
        assert_eq!(event(&mut unrelated).await["message"], own);
        let own = post(&foreign, foreign.channel).await;
        assert_eq!(event(&mut other_org).await["message"], own);
    }
}

#[sqlx::test]
async fn notification_authorization_failure_closes_with_4008_and_reconnect_replays(pool: PgPool) {
    let f = fixture(&pool).await;
    let mut socket = f.server.connect(&f.token).await;
    subscribe(&mut socket, f.channel, 0).await;
    ready(&mut socket, f.channel, 0).await;
    let key = Uuid::new_v4();
    let gate = messages::pause_publication(key);
    let committed = send(&f, &f.token, f.channel, key, "authorization unavailable").await;
    publication_entered(&gate).await;
    sqlx::query("ALTER TABLE channels RENAME COLUMN visibility TO unavailable_visibility")
        .execute(&pool)
        .await
        .unwrap();
    gate.release.add_permits(1);
    closed(&mut socket, CLOSE_QUEUE_OVERFLOW).await;
    f.state.message_delivery.flush().await;
    sqlx::query("ALTER TABLE channels RENAME COLUMN unavailable_visibility TO visibility")
        .execute(&pool)
        .await
        .unwrap();
    let mut reconnect = f.server.connect(&f.token).await;
    subscribe(&mut reconnect, f.channel, 0).await;
    assert_eq!(event(&mut reconnect).await["message"], committed);
    ready(&mut reconnect, f.channel, 1).await;
}

#[sqlx::test]
async fn notification_rechecks_public_visibility_after_http_response(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_, nonmember) = member(&pool, f.organization).await;
    let mut socket = f.server.connect(&nonmember).await;
    subscribe(&mut socket, f.channel, 0).await;
    ready(&mut socket, f.channel, 0).await;
    let key = Uuid::new_v4();
    let gate = messages::pause_publication(key);
    let committed = send(&f, &f.token, f.channel, key, "public becomes private").await;
    publication_entered(&gate).await;
    sqlx::query(
        "UPDATE channels SET visibility = 'private' WHERE organization_id = $1 AND id = $2",
    )
    .bind(f.organization)
    .bind(f.channel)
    .execute(&pool)
    .await
    .unwrap();
    gate.release.add_permits(1);
    f.state.message_delivery.flush().await;
    // An authorized public Channel supplies a FIFO silence barrier after fan-out finishes.
    let barrier = channel(&pool, f.organization, f.member, false).await;
    subscribe(&mut socket, barrier, 0).await;
    ready(&mut socket, barrier, 0).await;
    subscribe(&mut socket, f.channel, 0).await;
    denied(&mut socket, f.channel).await;
    sqlx::query("UPDATE channels SET visibility = 'public' WHERE organization_id = $1 AND id = $2")
        .bind(f.organization)
        .bind(f.channel)
        .execute(&pool)
        .await
        .unwrap();
    subscribe(&mut socket, f.channel, 0).await;
    assert_eq!(event(&mut socket).await["message"], committed);
    ready(&mut socket, f.channel, 1).await;
    let next = post(&f, f.channel).await;
    assert_eq!(event(&mut socket).await["message"], next);
}
