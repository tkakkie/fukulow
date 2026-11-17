use super::*;

pub(super) async fn socket_pair() -> (Client, WebSocketStream<TcpStream>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (client, peer) = tokio::join!(
        tokio_tungstenite::connect_async(format!("ws://{address}")),
        async {
            let (stream, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(stream).await.unwrap()
        }
    );
    (client.unwrap().0, peer)
}

#[tokio::test]
async fn silence_answers_ping_and_skips_pong_for_the_full_window() {
    let (mut client, mut peer) = socket_pair().await;
    peer.send(tungstenite::Message::Ping(vec![1].into()))
        .await
        .unwrap();
    peer.send(tungstenite::Message::Pong(vec![2].into()))
        .await
        .unwrap();
    let start = tokio::time::Instant::now();
    silent(&mut client).await;
    assert!(start.elapsed() >= Duration::from_millis(100));
    assert_eq!(
        peer.next().await.unwrap().unwrap(),
        tungstenite::Message::Pong(vec![1].into())
    );
}

#[tokio::test]
#[should_panic(expected = "expected delivery silence, got Ok(Some(Ok(Text(")]
async fn silence_rejects_unexpected_message_after_keepalive() {
    let (mut client, mut peer) = socket_pair().await;
    peer.send(tungstenite::Message::Ping(Default::default()))
        .await
        .unwrap();
    peer.send(tungstenite::Message::Pong(Default::default()))
        .await
        .unwrap();
    peer.send(tungstenite::Message::text(
        json!({"type":"message","message":{"channel_id":Uuid::new_v4(),"seq":1}}).to_string(),
    ))
    .await
    .unwrap();
    silent(&mut client).await;
}
