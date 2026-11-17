use futures_util::FutureExt;

/// Delivery assertions ignore keepalive, but retain an explicitly expected barrier Pong.
pub(crate) async fn websocket_delivery_next<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    expected_pong: Option<&[u8]>,
) -> Option<Result<tokio_tungstenite::tungstenite::Message, tokio_tungstenite::tungstenite::Error>>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let mut flush_error = None;
    loop {
        // A failed Pong write must not hide a frame already in tungstenite's buffer.
        // After write failure, inspect only immediately available input.
        let next = if flush_error.is_some() {
            socket.next().now_or_never().flatten()
        } else {
            socket.next().await
        };
        match next {
            Some(Ok(Message::Ping(_))) => {
                if let Err(error) = socket.flush().await {
                    flush_error = Some(error);
                }
            }
            Some(Ok(Message::Pong(bytes))) if expected_pong != Some(bytes.as_ref()) => {}
            Some(Ok(frame)) => return Some(Ok(frame)),
            other => return flush_error.map(Err).map(Some).unwrap_or(other),
        }
    }
}
