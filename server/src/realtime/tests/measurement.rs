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
    assert_eq!(f.state.message_delivery.notification_permits(), 0);
    let send_ms = start.elapsed().as_secs_f64() * 1000.0;
    let cold_start = std::time::Instant::now();
    let own = post(&f, cold).await;
    closed(&mut cold_socket, 1011).await;
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
    let mut recovered_cold = f.server.connect(&f.token).await;
    subscribe(&mut recovered_cold, cold, 0).await;
    assert_eq!(event(&mut recovered_cold).await["message"], own);
    ready(&mut recovered_cold, cold, 1).await;
    let own = post(&f, cold).await;
    assert_eq!(event(&mut recovered_cold).await["message"], own);
    eprintln!(
        "MEASURE_CURSOR sockets={count} offered={sends} accepted={accepted} recovered_cursor={cursor} next_gap={gap} rejected={} burst_http_ms={send_ms:.3} cold_1011_ms={cold_ms:.3} hot_first_1011_ms={first_close_ms:.3} first_replay_ms={first_replay_ms:.3} hot_second_1011_ms={second_close_ms:.3} second_replay_ms={second_replay_ms:.3} reconnects={} cold_recovered=true hot_recovered=true",
        sends - accepted,
        count * 2
    );
    drop(recovered_hot);
    drop(recovered_cold);
    f.state.message_delivery.flush().await;
    pool.close().await;
}
