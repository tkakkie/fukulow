use super::*;

fn watch_close(clients: &mut tokio::task::JoinSet<()>, mut socket: Client) {
    clients.spawn(async move {
        while let Some(frame) = socket.next().await {
            match frame.unwrap() {
                tungstenite::Message::Ping(_) => socket.flush().await.unwrap(),
                tungstenite::Message::Close(Some(close)) => {
                    assert_eq!(u16::from(close.code), 1011);
                    return;
                }
                frame => panic!("unexpected measurement frame: {frame:?}"),
            }
        }
        panic!("measurement socket ended without 1011");
    });
}

async fn all_closed(clients: &mut tokio::task::JoinSet<()>) {
    tokio::time::timeout(Duration::from_secs(30), async {
        while let Some(result) = clients.join_next().await {
            result.unwrap();
        }
    })
    .await
    .unwrap();
}

// A controlled slow recovery holds the real publication cursor, not a DB row or
// the send path. All backlog Messages below are committed by concurrent sends.
#[sqlx::test]
#[ignore = "manual release cross-Channel starvation and two-cycle burst/replay measurement"]
async fn measure_cursor_starvation_and_burst_reconnects(pool: PgPool) {
    let count: usize = std::env::var("MEASURE_SOCKETS")
        .unwrap_or_else(|_| "1000".into())
        .parse()
        .unwrap();
    let sends: usize = std::env::var("MEASURE_SENDS")
        .unwrap_or_else(|_| "512".into())
        .parse()
        .unwrap();
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    assert!(count > 0);
    let f = fixture(&pool).await;
    let cold = channel(&pool, f.organization, f.member, false).await;
    let mut clients = tokio::task::JoinSet::new();
    for index in 0..count {
        let mut socket = f.server.connect(&f.token).await;
        subscribe(&mut socket, f.channel, 0).await;
        ready(&mut socket, f.channel, 0).await;
        watch_close(&mut clients, socket);
        if (index + 1).is_multiple_of(1000) {
            eprintln!("MEASURE prepared={}", index + 1);
        }
    }
    let mut cold_socket = f.server.connect(&f.token).await;
    subscribe(&mut cold_socket, cold, 0).await;
    ready(&mut cold_socket, cold, 0).await;
    // Replay takes longer than the heartbeat grace. Keep this client reading,
    // including Pings, while the hot sockets reconnect sequentially.
    let (cold_events, mut cold_received) = tokio::sync::mpsc::channel(3);
    let cold_reader = tokio::spawn(async move {
        let mut received = 0;
        while let Some(frame) = cold_socket.next().await {
            match frame.unwrap() {
                tungstenite::Message::Ping(_) => cold_socket.flush().await.unwrap(),
                tungstenite::Message::Text(text) => {
                    cold_events
                        .send(serde_json::from_str::<Value>(&text).unwrap())
                        .await
                        .unwrap();
                    received += 1;
                    if received == 3 {
                        return;
                    }
                }
                frame => panic!("unexpected cold measurement frame: {frame:?}"),
            }
        }
        panic!("cold measurement socket ended before all live Messages");
    });
    let gate = Arc::new(Gate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    let holder = {
        let delivery = f.state.message_delivery.clone();
        let gate = gate.clone();
        let org = f.organization;
        let channel = f.channel;
        tokio::spawn(async move {
            delivery
                .hold_publication_cursor(org, channel, &gate.entered, &gate.release)
                .await;
        })
    };
    entered(&gate).await;
    let start = std::time::Instant::now();
    let mut requests = tokio::task::JoinSet::new();
    for _ in 0..sends {
        let app = f.app.clone();
        let token = f.token.clone();
        let channel = f.channel;
        requests.spawn(async move {
            let response = request(
                &app,
                "POST",
                &format!("/api/v1/channels/{channel}/messages"),
                &token,
                json!({"client_message_id":Uuid::new_v4(),"body":"burst measurement"}),
            )
            .await;
            match response.status() {
                StatusCode::CREATED => true,
                StatusCode::SERVICE_UNAVAILABLE => {
                    let retry: u64 = response.headers()[header::RETRY_AFTER]
                        .to_str()
                        .unwrap()
                        .parse()
                        .unwrap();
                    assert!((1..=5).contains(&retry));
                    false
                }
                status => panic!("unexpected burst status {status}"),
            }
        });
    }
    let mut accepted = 0;
    while let Some(result) = requests.join_next().await {
        accepted += usize::from(result.unwrap());
    }
    assert!(
        accepted > 100,
        "probe needs a >50 gap beyond the first 40 notifications"
    );
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
    let send_ms = start.elapsed().as_secs_f64() * 1000.0;
    let cold_start = std::time::Instant::now();
    let own = post(&f, cold).await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), cold_received.recv())
            .await
            .unwrap()
            .unwrap()["message"],
        own
    );
    let cold_ms = cold_start.elapsed().as_secs_f64() * 1000.0;
    all_closed(&mut clients).await;
    let first_close_ms = start.elapsed().as_secs_f64() * 1000.0;
    // Reconnect once before unblocking so the real subscription lease retains the
    // cursor across epochs, as overlapping reconnect/recovery does in production.
    let replay_start = std::time::Instant::now();
    let mut clients = tokio::task::JoinSet::new();
    let mut first = f.server.connect(&f.token).await;
    subscribe(&mut first, f.channel, 0).await;
    for seq in 1..=accepted {
        assert_eq!(event(&mut first).await["message"]["seq"], seq);
    }
    ready(&mut first, f.channel, accepted as i64).await;
    watch_close(&mut clients, first);
    gate.release.add_permits(1);
    holder.await.unwrap();
    f.state.message_delivery.flush().await;
    let cursor = f
        .state
        .message_delivery
        .publication_cursor(f.organization, f.channel)
        .await
        .unwrap();
    let gap = accepted as i64 - cursor;
    assert!(
        gap > 50,
        "the next publication must cross the recovery page bound"
    );
    // Replay includes every commit, including those without a notification slot.
    for _ in 1..count {
        let mut socket = f.server.connect(&f.token).await;
        subscribe(&mut socket, f.channel, 0).await;
        for seq in 1..=accepted {
            assert_eq!(event(&mut socket).await["message"]["seq"], seq);
        }
        ready(&mut socket, f.channel, accepted as i64).await;
        watch_close(&mut clients, socket);
    }
    let first_replay_ms = replay_start.elapsed().as_secs_f64() * 1000.0;
    let second = std::time::Instant::now();
    let next = post(&f, f.channel).await;
    assert_eq!(next["seq"], accepted + 1);
    all_closed(&mut clients).await;
    let second_close_ms = second.elapsed().as_secs_f64() * 1000.0;
    let replay_start = std::time::Instant::now();
    for _ in 0..count {
        let mut socket = f.server.connect(&f.token).await;
        subscribe(&mut socket, f.channel, accepted as i64).await;
        assert_eq!(event(&mut socket).await["message"], next);
        ready(&mut socket, f.channel, accepted as i64 + 1).await;
    }
    let second_replay_ms = replay_start.elapsed().as_secs_f64() * 1000.0;
    let mut recovered_hot = f.server.connect(&f.token).await;
    subscribe(&mut recovered_hot, f.channel, accepted as i64 + 1).await;
    ready(&mut recovered_hot, f.channel, accepted as i64 + 1).await;
    let final_hot = post(&f, f.channel).await;
    assert_eq!(final_hot["seq"], accepted + 2);
    assert_eq!(event(&mut recovered_hot).await["message"], final_hot);
    // The original cold socket stays live through both hot reconnect cycles.
    let next_cold = post(&f, cold).await;
    assert_eq!(cold_received.recv().await.unwrap()["message"], next_cold);
    let mut recovered_cold = f.server.connect(&f.token).await;
    subscribe(&mut recovered_cold, cold, 0).await;
    assert_eq!(event(&mut recovered_cold).await["message"], own);
    assert_eq!(event(&mut recovered_cold).await["message"], next_cold);
    ready(&mut recovered_cold, cold, 2).await;
    let own = post(&f, cold).await;
    assert_eq!(event(&mut recovered_cold).await["message"], own);
    assert_eq!(cold_received.recv().await.unwrap()["message"], own);
    cold_reader.await.unwrap();
    eprintln!(
        "MEASURE_CURSOR sockets={count} offered={sends} accepted={accepted} recovered_cursor={cursor} next_gap={gap} rejected={} burst_http_ms={send_ms:.3} cold_live_ms={cold_ms:.3} cold_1011=0 hot_first_1011_ms={first_close_ms:.3} first_replay_ms={first_replay_ms:.3} hot_second_1011_ms={second_close_ms:.3} second_replay_ms={second_replay_ms:.3} reconnects={} cold_recovered=true hot_recovered=true",
        sends - accepted,
        count * 2
    );
    drop(recovered_hot);
    drop(recovered_cold);
    f.state.message_delivery.flush().await;
    pool.close().await;
}

// Same held-cursor/Router/WebSocket method as #178/#189, across Organizations.
// The configurable expected cap allows the identical probe to run on the baseline.
async fn organization_reservation_probe(pool: PgPool, offered: usize, cap: usize) {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let f = fixture(&pool).await;
    let b = organization(&pool).await;
    let (_, b_token) = member(&pool, b).await;
    // Reusing A's Channel UUID also checks that failure scope includes Organization.
    sqlx::query("INSERT INTO channels (organization_id, id, name, visibility) VALUES ($1, $2, 'B', 'public')")
        .bind(b).bind(f.channel).execute(&pool).await.unwrap();
    let mut b_socket = f.server.connect(&b_token).await;
    subscribe(&mut b_socket, f.channel, 0).await;
    ready(&mut b_socket, f.channel, 0).await;
    let mut affected = f.server.connect(&f.token).await;
    subscribe(&mut affected, f.channel, 0).await;
    ready(&mut affected, f.channel, 0).await;

    // Healthy many-Channel traffic, without injected delay: 320 concurrent sends,
    // 16 Channels and one real socket with independent ascending cursors.
    let mut healthy = f.server.connect(&f.token).await;
    let mut channels = Vec::new();
    for _ in 0..16 {
        let channel = channel(&pool, f.organization, f.member, false).await;
        subscribe(&mut healthy, channel, 0).await;
        ready(&mut healthy, channel, 0).await;
        channels.push(channel);
    }
    let start = std::time::Instant::now();
    let mut requests = tokio::task::JoinSet::new();
    for &channel in &channels {
        for _ in 0..20 {
            let app = f.app.clone();
            let token = f.token.clone();
            requests.spawn(async move {
                let response = request(
                    &app,
                    "POST",
                    &format!("/api/v1/channels/{channel}/messages"),
                    &token,
                    json!({"client_message_id":Uuid::new_v4(),"body":"healthy many-Channel"}),
                )
                .await;
                assert_eq!(response.status(), StatusCode::CREATED);
            });
        }
    }
    // Read concurrently, keeping the shared 256-event queue drained.
    let reader = tokio::spawn(async move {
        let mut cursors = HashMap::new();
        for _ in 0..320 {
            let message = event(&mut healthy).await;
            let channel = message["message"]["channel_id"]
                .as_str()
                .unwrap()
                .to_owned();
            let cursor = cursors.entry(channel).or_insert(0);
            *cursor += 1;
            assert_eq!(message["message"]["seq"], *cursor);
        }
        assert_eq!(cursors.len(), 16);
        assert!(cursors.values().all(|&seq| seq == 20));
    });
    while let Some(result) = requests.join_next().await {
        result.unwrap();
    }
    reader.await.unwrap();
    f.state.message_delivery.flush().await;
    let healthy_ms = start.elapsed().as_secs_f64() * 1000.0;

    let mut holders = Vec::new();
    let mut hot = Vec::new();
    for _ in 0..offered.div_ceil(40) {
        let channel = channel(&pool, f.organization, f.member, false).await;
        let gate = Arc::new(Gate {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
        });
        let holder = {
            let delivery = f.state.message_delivery.clone();
            let gate = gate.clone();
            let organization = f.organization;
            tokio::spawn(async move {
                delivery
                    .hold_publication_cursor(organization, channel, &gate.entered, &gate.release)
                    .await;
            })
        };
        entered(&gate).await;
        holders.push((gate, holder));
        hot.push(channel);
    }
    let start = std::time::Instant::now();
    for index in 0..offered {
        let app = f.app.clone();
        let token = f.token.clone();
        let channel = hot[index / 40];
        requests.spawn(async move {
            let response = request(
                &app,
                "POST",
                &format!("/api/v1/channels/{channel}/messages"),
                &token,
                json!({"client_message_id":Uuid::new_v4(),"body":"held Organization"}),
            )
            .await;
            assert_eq!(response.status(), StatusCode::CREATED);
        });
    }
    while let Some(result) = requests.join_next().await {
        result.unwrap();
    }
    let fill_ms = start.elapsed().as_secs_f64() * 1000.0;
    let reserved = f.state.message_delivery.notification_reservations();
    assert_eq!(reserved.0, offered.min(cap));
    assert_eq!(f.state.message_delivery.notification_permits(), 40);

    let start = std::time::Instant::now();
    let b_message = send(&f, &b_token, f.channel, Uuid::new_v4(), "B while A held").await;
    let b_closed = reserved.0 == 2048;
    if b_closed {
        closed(&mut b_socket, 1011).await;
    } else {
        assert_eq!(event(&mut b_socket).await["message"], b_message);
    }
    let b_ms = start.elapsed().as_secs_f64() * 1000.0;
    let start = std::time::Instant::now();
    let a_message = post(&f, f.channel).await;
    let a_closed = reserved.0 >= cap;
    if a_closed {
        closed(&mut affected, 1011).await;
    } else {
        assert_eq!(event(&mut affected).await["message"], a_message);
    }
    let a_ms = start.elapsed().as_secs_f64() * 1000.0;
    let start = std::time::Instant::now();
    if a_closed {
        affected = f.server.connect(&f.token).await;
        subscribe(&mut affected, f.channel, 0).await;
        assert_eq!(event(&mut affected).await["message"], a_message);
        ready(&mut affected, f.channel, 1).await;
    }
    let replay_ms = start.elapsed().as_secs_f64() * 1000.0;
    for (gate, holder) in holders {
        gate.release.add_permits(1);
        holder.await.unwrap();
    }
    f.state.message_delivery.flush().await;
    assert_eq!(f.state.message_delivery.notification_reservations(), (0, 0));
    let next = post(&f, f.channel).await;
    assert_eq!(event(&mut affected).await["message"], next);
    if b_closed {
        b_socket = f.server.connect(&b_token).await;
        subscribe(&mut b_socket, f.channel, 0).await;
        assert_eq!(event(&mut b_socket).await["message"], b_message);
        ready(&mut b_socket, f.channel, 1).await;
    }
    let next = send(&f, &b_token, f.channel, Uuid::new_v4(), "B after release").await;
    assert_eq!(event(&mut b_socket).await["message"], next);
    f.state.message_delivery.flush().await;
    eprintln!(
        "MEASURE_ORG offered={offered} cap={cap} healthy_deliveries=320 healthy_ms={healthy_ms:.3} fill_ms={fill_ms:.3} reservations={} org_entries={} execution_free=40 b_1011={b_closed} b_ms={b_ms:.3} a_1011={a_closed} a_ms={a_ms:.3} a_replay_ms={replay_ms:.3} released={:?} a_live_recovered=true b_live_recovered=true",
        reserved.0,
        reserved.1,
        f.state.message_delivery.notification_reservations()
    );
    pool.close().await;
}

#[sqlx::test]
#[ignore = "manual release per-Organization reservation comparison"]
async fn measure_organization_notification_reservations(pool: PgPool) {
    let offered = std::env::var("MEASURE_RESERVATIONS")
        .unwrap_or_else(|_| "2048".into())
        .parse()
        .unwrap();
    let cap = std::env::var("MEASURE_ORG_CAP")
        .unwrap_or_else(|_| "512".into())
        .parse()
        .unwrap();
    organization_reservation_probe(pool, offered, cap).await;
}

#[sqlx::test]
async fn organization_cap_preserves_other_organization_live_delivery_and_replays_affected_channel(
    pool: PgPool,
) {
    organization_reservation_probe(
        pool,
        messages::MAX_ORGANIZATION_NOTIFICATIONS,
        messages::MAX_ORGANIZATION_NOTIFICATIONS,
    )
    .await;
}
