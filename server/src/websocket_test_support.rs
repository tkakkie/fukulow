use std::{pin::Pin, task::Poll};

use futures_util::{Sink, Stream, future::poll_fn};

/// Delivery assertions ignore keepalive, but retain an explicitly expected barrier Pong.
pub(crate) async fn websocket_delivery_next<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    expected_pong: Option<&[u8]>,
) -> Option<Result<tokio_tungstenite::tungstenite::Message, tokio_tungstenite::tungstenite::Error>>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    use tokio_tungstenite::tungstenite::Message;
    let mut flush_error = None;
    let mut flush_pending = false;
    loop {
        let next = poll_fn(|cx| {
            // Drive Pong output without blocking reads behind write backpressure.
            if flush_pending && flush_error.is_none() {
                match Pin::new(&mut *socket).poll_flush(cx) {
                    Poll::Ready(Ok(())) => flush_pending = false,
                    Poll::Ready(Err(error)) => flush_error = Some(error),
                    Poll::Pending => {}
                }
            }
            let next = Pin::new(&mut *socket).poll_next(cx);
            // After write failure, inspect only immediately available input.
            if next.is_pending() && flush_error.is_some() {
                Poll::Ready(None)
            } else {
                next
            }
        })
        .await;
        match next {
            Some(Ok(Message::Ping(_))) => flush_pending = true,
            Some(Ok(Message::Pong(bytes))) if expected_pong != Some(bytes.as_ref()) => {}
            Some(Ok(frame)) => return Some(Ok(frame)),
            other => return flush_error.map(Err).map(Some).unwrap_or(other),
        }
    }
}
