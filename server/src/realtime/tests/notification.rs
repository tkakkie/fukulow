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

pub(super) async fn publication_entered(gate: &messages::PublicationGate) {
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
async fn held_hot_cursor_preserves_cold_channel_live_delivery_and_scoped_saturation(pool: PgPool) {
    let f = fixture(&pool).await;
    let cold = channel(&pool, f.organization, f.member, false).await;
    let mut hot_socket = f.server.connect(&f.token).await;
    subscribe(&mut hot_socket, f.channel, 0).await;
    ready(&mut hot_socket, f.channel, 0).await;
    let mut cold_sockets = Vec::new();
    for _ in 0..2 {
        let mut socket = f.server.connect(&f.token).await;
        subscribe(&mut socket, cold, 0).await;
        ready(&mut socket, cold, 0).await;
        cold_sockets.push(socket);
    }
    let gate = Arc::new(Gate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    let holder = {
        let delivery = f.state.message_delivery.clone();
        let gate = gate.clone();
        let organization = f.organization;
        let channel = f.channel;
        tokio::spawn(async move {
            delivery
                .hold_publication_cursor(organization, channel, &gate.entered, &gate.release)
                .await;
        })
    };
    entered(&gate).await;
    for _ in 0..messages::MAX_IN_FLIGHT_NOTIFICATIONS {
        post(&f, f.channel).await;
    }
    assert_eq!(
        f.state
            .message_delivery
            .channel_notification_permits(f.organization, f.channel),
        0
    );
    assert_eq!(
        f.state.message_delivery.notification_permits(),
        messages::MAX_IN_FLIGHT_NOTIFICATIONS
    );
    let own = post(&f, cold).await;
    for socket in &mut cold_sockets {
        assert_eq!(event(socket).await["message"], own);
    }
    // Excess hot work still fails closed, without closing the cold sockets.
    post(&f, f.channel).await;
    closed(&mut hot_socket, 1011).await;
    let own = post(&f, cold).await;
    for socket in &mut cold_sockets {
        assert_eq!(event(socket).await["message"], own);
    }
    gate.release.add_permits(1);
    holder.await.unwrap();
    f.state.message_delivery.flush().await;
    let mut recovered = f.server.connect(&f.token).await;
    subscribe(&mut recovered, f.channel, 0).await;
    for seq in 1..=41 {
        assert_eq!(event(&mut recovered).await["message"]["seq"], seq);
    }
    ready(&mut recovered, f.channel, 41).await;
    let next = post(&f, f.channel).await;
    assert_eq!(event(&mut recovered).await["message"], next);
    f.state.message_delivery.flush().await;
    for socket in &mut cold_sockets {
        silent(socket).await;
    }
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
async fn dropped_notification_large_gap_never_overflows_undrained_subscribers_and_replays_in_order(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let mut before_failure = f.server.connect(&f.token).await;
    subscribe(&mut before_failure, f.channel, 0).await;
    ready(&mut before_failure, f.channel, 0).await;
    let first_key = Uuid::new_v4();
    let dropped = messages::pause_publication(first_key);
    send(&f, &f.token, f.channel, first_key, "dropped notification").await;
    publication_entered(&dropped).await;
    // Retain the Channel's lagging publication cursor across the old socket exit.
    let late_key = Uuid::new_v4();
    let late = messages::pause_publication(late_key);
    send(&f, &f.token, f.channel, late_key, "late notification").await;
    publication_entered(&late).await;
    dropped.task.lock().unwrap().as_ref().unwrap().abort();
    closed(&mut before_failure, 1011).await;

    let through = LIVE_QUEUE_CAPACITY as i64 + 44;
    sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body) SELECT $1,gen_random_uuid(),$2,n,$3,gen_random_uuid(),'committed backlog' FROM generate_series(3,$4::bigint) n")
        .bind(f.organization).bind(f.channel).bind(f.member).bind(through).execute(&pool).await.unwrap();
    sqlx::query(
        "UPDATE channel_message_sequences SET seq=$3 WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(f.organization)
    .bind(f.channel)
    .bind(through)
    .execute(&pool)
    .await
    .unwrap();
    let mut replayed = f.server.connect(&f.token).await;
    subscribe(&mut replayed, f.channel, 0).await;
    for seq in 1..=through {
        assert_eq!(event(&mut replayed).await["message"]["seq"], seq);
    }
    ready(&mut replayed, f.channel, through).await;

    // A replay on another Channel prevents this socket from draining its live queue.
    let other = channel(&pool, f.organization, f.member, false).await;
    let parked = pause(other);
    subscribe(&mut replayed, other, 0).await;
    entered(&parked).await;
    // Another subscriber has registered but is still inside this Channel's replay.
    let mut mid_replay = f.server.connect(&f.token).await;
    let replay = pause(f.channel);
    subscribe(&mut mid_replay, f.channel, 0).await;
    entered(&replay).await;
    let published = post(&f, f.channel).await;
    assert_eq!(published["seq"], through + 1);
    // Overflow has priority over failure: these real closes prove no 4008 was set.
    closed(&mut replayed, 1011).await;
    closed(&mut mid_replay, 1011).await;

    // A subscriber after the second latch replays the skipped prefix exactly once.
    let mut recovered = f.server.connect(&f.token).await;
    subscribe(&mut recovered, f.channel, 0).await;
    for seq in 1..=through + 1 {
        assert_eq!(event(&mut recovered).await["message"]["seq"], seq);
    }
    ready(&mut recovered, f.channel, through + 1).await;
    late.release.add_permits(1);
    f.state.message_delivery.flush().await;
    // A late old notification is suppressed, and the advanced cursor permits live delivery.
    let next = post(&f, f.channel).await;
    assert_eq!(next["seq"], through + 2);
    assert_eq!(event(&mut recovered).await["message"], next);
    f.state.message_delivery.flush().await;
    silent(&mut recovered).await;
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
    access_loss::access_lost(&mut socket, f.channel).await;
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
