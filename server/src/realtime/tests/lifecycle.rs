use super::*;
use crate::realtime::connection::Lifecycle;
use tokio::sync::oneshot;

async fn lifecycle_socket(f: &Fixture) -> (Server, Client, oneshot::Receiver<()>) {
    let (done, finished) = oneshot::channel();
    let done = Arc::new(Mutex::new(Some(done)));
    let router = Router::new()
        .route(
            "/api/v1/ws",
            axum::routing::get(
                move |State(state): State<AppState>, auth: Auth, ws: WebSocketUpgrade| {
                    let done = done.clone();
                    async move {
                        ws.on_upgrade(move |socket| async move {
                            connected_with_lifecycle(
                                socket,
                                state,
                                auth,
                                Lifecycle {
                                    ping_interval: Duration::from_secs(1),
                                    idle_timeout: Duration::from_secs(3),
                                },
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
async fn missing_pong_disconnects_idle_websocket(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_server, mut socket, finished) = lifecycle_socket(&f).await;
    advance(Duration::from_secs(1)).await;
    assert!(matches!(
        frame(&mut socket).await,
        tungstenite::Message::Ping(_)
    ));
    // Reading queues an automatic pong, but not polling/writing again leaves it unsent.
    advance(Duration::from_secs(2)).await;
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
        advance(Duration::from_secs(1)).await;
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
    // A pong queued while replay holds the loop must count before an overdue idle tick.
    let gate = pause(f.channel);
    subscribe(&mut socket, f.channel, 6).await;
    entered(&gate).await;
    socket
        .send(tungstenite::Message::Pong(vec![1].into()))
        .await
        .unwrap();
    advance(Duration::from_secs(4)).await;
    gate.release.add_permits(1);
    assert_eq!(event(&mut socket).await["message"]["seq"], 7);
    ready(&mut socket, f.channel, 7).await;
    assert!(matches!(
        frame(&mut socket).await,
        tungstenite::Message::Ping(_)
    ));
    socket.flush().await.unwrap();
    let canonical = post(&f, f.channel).await;
    assert_eq!(event(&mut socket).await["message"], canonical);
    socket.close(None).await.unwrap();
    assert_eq!(frame(&mut socket).await, tungstenite::Message::Close(None));
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
