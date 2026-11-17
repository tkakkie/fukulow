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

// Model a writable socket under backpressure. Reads may continue while automatic
// Pong writes are blocked; an explicit flush must keep polling the write side.
pub(super) struct Backpressure {
    stream: tokio::io::DuplexStream,
    pub(super) writes: usize,
    failed_writes: usize,
    pub(super) blocked: bool,
}
impl tokio::io::AsyncRead for Backpressure {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.stream).poll_read(cx, buffer)
    }
}
impl tokio::io::AsyncWrite for Backpressure {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bytes: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        self.writes += 1;
        if self.blocked {
            return std::task::Poll::Pending;
        }
        if !self.writes.is_multiple_of(3) {
            cx.waker().wake_by_ref();
            return std::task::Poll::Pending;
        }
        let result = std::pin::Pin::new(&mut self.stream).poll_write(cx, bytes);
        if matches!(result, std::task::Poll::Ready(Err(_))) {
            self.failed_writes += 1;
        }
        result
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

pub(super) async fn buffered_pair(
    bytes: Vec<u8>,
) -> (
    WebSocketStream<Backpressure>,
    WebSocketStream<tokio::io::DuplexStream>,
) {
    use tungstenite::protocol::Role;
    let (client, peer) = tokio::io::duplex(4096);
    (
        WebSocketStream::from_partially_read(
            Backpressure {
                stream: client,
                writes: 0,
                failed_writes: 0,
                blocked: false,
            },
            bytes,
            Role::Client,
            None,
        )
        .await,
        WebSocketStream::from_raw_socket(peer, Role::Server, None).await,
    )
}

#[tokio::test]
async fn delivery_read_skips_flush_after_failed_pong_and_another_ping() {
    let (mut client, peer) =
        buffered_pair(vec![0x89, 1, 1, 0x8a, 1, 3, 0x89, 1, 2, 0x81, 1, b'x']).await;
    drop(peer);
    client.get_mut().writes = 2; // The first Pong write fails immediately.
    assert_eq!(
        crate::websocket_test_support::websocket_delivery_next(&mut client, None)
            .await
            .unwrap()
            .unwrap(),
        tungstenite::Message::text("x")
    );
    // Reads may try a nonblocking automatic write, but must not drive another
    // explicit flush through backpressure to a second BrokenPipe.
    assert_eq!(client.get_mut().failed_writes, 1);
    // The intervening Pong must not retry the failed flush either. Only the
    // second Ping's automatic write adds one Pending poll after the failure.
    assert_eq!(client.get_mut().writes, 4);
}

#[tokio::test(start_paused = true)]
#[should_panic(expected = "expected delivery silence, got Ok(Some(Ok(Text(")]
async fn silence_rejects_buffered_message_while_pong_write_is_blocked() {
    let (mut client, _peer) = buffered_pair(vec![0x89, 1, 1, 0x81, 1, b'x']).await;
    client.get_mut().blocked = true;
    silent(&mut client).await;
}

#[tokio::test]
async fn delivery_read_preserves_buffered_frames_after_pong_flush_failure() {
    use tungstenite::protocol::Role;
    for tail in [vec![0x81, 1, b'x'], vec![0x88, 2, 0x03, 0xe8], vec![]] {
        let expected = match tail.first() {
            Some(0x81) => Some(tungstenite::Message::text("x")),
            Some(0x88) => Some(tungstenite::Message::Close(Some(
                tungstenite::protocol::CloseFrame {
                    code: tungstenite::protocol::frame::coding::CloseCode::Normal,
                    reason: "".into(),
                },
            ))),
            _ => None,
        };
        let (stream, peer) = tokio::io::duplex(4096);
        drop(peer); // Every Pong write fails deterministically with BrokenPipe.
        let mut bytes = vec![0x89, 1, 1];
        bytes.extend(tail);
        let mut socket =
            WebSocketStream::from_partially_read(stream, bytes, Role::Client, None).await;
        let result = crate::websocket_test_support::websocket_delivery_next(&mut socket, None)
            .await
            .unwrap();
        if let Some(expected) = expected {
            assert_eq!(result.unwrap(), expected);
        } else {
            assert!(
                matches!(result, Err(tungstenite::Error::Io(error)) if error.kind() == std::io::ErrorKind::BrokenPipe)
            );
        }
    }
}

#[tokio::test]
async fn delivery_frame_answers_keepalive_and_preserves_text() {
    let (mut client, mut peer) = socket_pair().await;
    peer.send(tungstenite::Message::Ping(vec![1].into()))
        .await
        .unwrap();
    peer.send(tungstenite::Message::Pong(vec![2].into()))
        .await
        .unwrap();
    peer.send(tungstenite::Message::text("exact payload"))
        .await
        .unwrap();
    assert_eq!(
        delivery_frame(&mut client).await,
        tungstenite::Message::text("exact payload")
    );
    assert_eq!(
        peer.next().await.unwrap().unwrap(),
        tungstenite::Message::Pong(vec![1].into())
    );
}
