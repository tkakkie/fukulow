use super::*;
use crate::realtime::connection::Lifecycle;
use tokio::sync::oneshot;

// Keep explicit clock jumps below the session monitor's independent 30 s SQL recheck.
const PING_INTERVAL: Duration = Duration::from_secs(2);
const IDLE_TIMEOUT: Duration = Duration::from_secs(6);

async fn lifecycle_socket(f: &Fixture) -> (Server, Client, oneshot::Receiver<()>) {
    let (done, finished) = oneshot::channel();
    let done = Arc::new(Mutex::new(Some(done)));
    let router = Router::new()
        .route(
            "/api/v1/orgs/{org}/ws",
            axum::routing::get(
                move |State(state): State<AppState>, auth: Auth, ws: WebSocketUpgrade| {
                    let done = done.clone();
                    async move {
                        let work = state.shutdown.sockets.enter();
                        let permit = state.socket_gate.admit(auth.account_id).unwrap();
                        ws.on_upgrade(move |socket| async move {
                            connected_with_lifecycle(
                                socket,
                                state,
                                auth,
                                permit,
                                Lifecycle {
                                    ping_interval: PING_INTERVAL,
                                    idle_timeout: IDLE_TIMEOUT,
                                },
                                work,
                            )
                            .await;
                            let _ = done.lock().unwrap().take().unwrap().send(());
                        })
                    }
                },
            ),
        )
        .with_state(f.state.clone());
    let server = Server::start(router).await;
    let mut socket = server.connect(&f.token).await;
    // The reply proves session admission and connection-loop initialization completed.
    subscribe(&mut socket, f.channel, 0).await;
    ready(&mut socket, f.channel, 0).await;
    (server, socket, finished)
}

async fn advance(duration: Duration) {
    tokio::time::pause();
    tokio::time::advance(duration).await;
    // TCP/PostgreSQL I/O runs on real time; do not let paused-time auto-advance race it.
    tokio::time::resume();
}

#[sqlx::test]
async fn frame_live_and_ping_traffic_does_not_repoll_failure_waits(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_server, mut socket, _finished) = lifecycle_socket(&f).await;
    tokio::task::yield_now().await;
    let polls = || {
        f.state
            .message_delivery
            .failure_wait_polls(f.organization, f.channel)
    };
    let initial = polls();
    assert!(initial > 0, "failure monitor has not registered its wait");
    for _ in 0..64 {
        socket
            .send(tungstenite::Message::Text("invalid".into()))
            .await
            .unwrap();
        assert_eq!(event(&mut socket).await["code"], "invalid_input");
        socket
            .send(tungstenite::Message::Ping(Default::default()))
            .await
            .unwrap();
        assert!(matches!(
            frame(&mut socket).await,
            tungstenite::Message::Pong(_)
        ));
    }
    for _ in 0..3 {
        advance(PING_INTERVAL).await;
        assert!(matches!(
            frame(&mut socket).await,
            tungstenite::Message::Ping(_)
        ));
        socket.flush().await.unwrap();
        let message = post(&f, f.channel).await;
        assert_eq!(event(&mut socket).await["message"], message);
        f.state.message_delivery.flush().await;
    }
    assert_eq!(polls(), initial, "socket traffic re-polled epoch waits");
}

#[sqlx::test]
async fn missing_pong_disconnects_idle_websocket(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_server, mut socket, finished) = lifecycle_socket(&f).await;
    advance(PING_INTERVAL).await;
    assert!(matches!(
        frame(&mut socket).await,
        tungstenite::Message::Ping(_)
    ));
    // Reading queues an automatic pong, but not polling/writing again leaves it unsent.
    advance(IDLE_TIMEOUT).await;
    tokio::time::timeout(Duration::from_secs(5), finished)
        .await
        .unwrap()
        .unwrap();
    // Drain the second ping, if the skipped-tick policy sent one before the deadline.
    loop {
        match frame(&mut socket).await {
            tungstenite::Message::Ping(_) => {}
            tungstenite::Message::Close(Some(close)) => {
                assert_eq!(u16::from(close.code), 1001);
                break;
            }
            other => panic!("expected ping or idle close, got {other:?}"),
        }
    }
}

#[sqlx::test]
async fn answering_pings_keeps_websocket_and_live_delivery_healthy(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_server, mut socket, mut finished) = lifecycle_socket(&f).await;
    // Only Pong frames go from client to server after the initial subscription.
    for _ in 0..7 {
        advance(PING_INTERVAL).await;
        assert!(matches!(
            frame(&mut socket).await,
            tungstenite::Message::Ping(_)
        ));
        socket.flush().await.unwrap();
        let canonical = post(&f, f.channel).await;
        assert_eq!(event(&mut socket).await["message"], canonical);
        assert!(matches!(
            finished.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
    }
    socket.close(None).await.unwrap();
    assert_eq!(frame(&mut socket).await, tungstenite::Message::Close(None));
}

async fn post_replay_ping(f: &Fixture, socket: &mut Client) {
    let canonical = post(f, f.channel).await;
    assert_eq!(event(socket).await["message"], canonical);
    let gate = pause(f.channel);
    resubscribe(socket, f.channel, 0).await;
    entered(&gate).await;
    // No client frame is sent while replay prevents the first heartbeat Ping.
    advance(IDLE_TIMEOUT + PING_INTERVAL).await;
    gate.release.add_permits(1);
    assert_eq!(event(socket).await["message"], canonical);
    ready(socket, f.channel, 1).await;
    assert!(matches!(frame(socket).await, tungstenite::Message::Ping(_)));
}

#[sqlx::test]
async fn answering_post_replay_ping_preserves_websocket_and_live_delivery(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_server, mut socket, mut finished) = lifecycle_socket(&f).await;
    post_replay_ping(&f, &mut socket).await;
    // Even an answer partway through the fresh grace period must keep the socket alive.
    advance(IDLE_TIMEOUT / 2).await;
    assert!(matches!(
        finished.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    socket.flush().await.unwrap();
    let canonical = post(&f, f.channel).await;
    assert_eq!(event(&mut socket).await["message"], canonical);
    // Continue beyond the original post-replay Ping's deadline, answering each Ping.
    for _ in 0..4 {
        advance(PING_INTERVAL).await;
        assert!(matches!(
            frame(&mut socket).await,
            tungstenite::Message::Ping(_)
        ));
        socket.flush().await.unwrap();
        let canonical = post(&f, f.channel).await;
        assert_eq!(event(&mut socket).await["message"], canonical);
    }
    socket.close(None).await.unwrap();
    assert_eq!(frame(&mut socket).await, tungstenite::Message::Close(None));
}

#[sqlx::test]
async fn unanswered_post_replay_ping_closes_only_after_full_grace(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_server, mut socket, mut finished) = lifecycle_socket(&f).await;
    post_replay_ping(&f, &mut socket).await;
    // Do not poll or flush the client: its automatically queued Pong stays unsent.
    advance(IDLE_TIMEOUT / 2).await;
    assert!(matches!(
        finished.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    advance(IDLE_TIMEOUT / 2).await;
    tokio::time::timeout(Duration::from_secs(5), finished)
        .await
        .unwrap()
        .unwrap();
    loop {
        match frame(&mut socket).await {
            tungstenite::Message::Ping(_) => {}
            tungstenite::Message::Close(Some(close)) => {
                assert_eq!(u16::from(close.code), 1001);
                break;
            }
            other => panic!("expected ping or idle close, got {other:?}"),
        }
    }
}

#[sqlx::test]
async fn pong_queued_during_replay_clears_outstanding_ping(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_server, mut socket, _finished) = lifecycle_socket(&f).await;
    advance(PING_INTERVAL).await;
    assert!(matches!(
        frame(&mut socket).await,
        tungstenite::Message::Ping(_)
    ));
    let gate = pause(f.channel);
    resubscribe(&mut socket, f.channel, 0).await;
    entered(&gate).await;
    socket
        .send(tungstenite::Message::Pong(vec![1].into()))
        .await
        .unwrap();
    advance(IDLE_TIMEOUT + PING_INTERVAL).await;
    gate.release.add_permits(1);
    ready(&mut socket, f.channel, 0).await;
    let canonical = post(&f, f.channel).await;
    assert_eq!(event(&mut socket).await["message"], canonical);
    socket.close(None).await.unwrap();
    // An overdue heartbeat may also have sent a Ping before consuming the queued Pong.
    loop {
        match frame(&mut socket).await {
            tungstenite::Message::Ping(_) => {}
            close => {
                assert_eq!(close, tungstenite::Message::Close(None));
                break;
            }
        }
    }
}

#[sqlx::test]
async fn client_initiated_close_gets_close_frame_back(pool: PgPool) {
    let f = fixture(&pool).await;
    for close in [
        None,
        Some(tungstenite::protocol::CloseFrame {
            code: tungstenite::protocol::frame::coding::CloseCode::Normal,
            reason: "leaving".into(),
        }),
    ] {
        let mut socket = f.server.connect(&f.token).await;
        subscribe(&mut socket, f.channel, 0).await;
        ready(&mut socket, f.channel, 0).await;
        socket.close(close.clone()).await.unwrap();
        assert_eq!(frame(&mut socket).await, tungstenite::Message::Close(close));
    }
}
