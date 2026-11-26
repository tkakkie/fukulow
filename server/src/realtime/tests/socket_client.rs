use super::{ClientMessage, Duration, Uuid, socket_server::scoped_path};
use axum::http::header;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{self, client::IntoClientRequest},
};

pub(super) type Client = WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

/// A socket to a server whose `Server` handle another task owns.
pub(super) async fn connect_at(address: std::net::SocketAddr, token: &str) -> Client {
    try_connect_at(address, token).await.unwrap()
}
pub(super) async fn try_connect_at(
    address: std::net::SocketAddr,
    token: &str,
) -> Result<Client, tungstenite::Error> {
    let mut request = format!("ws://{address}{}", scoped_path("/api/v1/ws", token))
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    Ok(tokio_tungstenite::connect_async(request).await?.0)
}

pub(super) async fn control(
    client: &mut (impl futures_util::Sink<tungstenite::Message, Error = tungstenite::Error> + Unpin),
    control: ClientMessage,
) -> Result<(), tungstenite::Error> {
    client
        .send(tungstenite::Message::text(
            serde_json::to_string(&control).unwrap(),
        ))
        .await
}
pub(super) async fn subscribe(client: &mut Client, channel: Uuid, after: i64) {
    control(
        client,
        ClientMessage::Subscribe {
            history_generation: None,
            channel_id: channel,
            after_seq: after,
        },
    )
    .await
    .unwrap();
}
/// A fresh subscription on a subscribed Channel: a duplicate subscribe is a no-op (#196).
pub(super) async fn resubscribe(client: &mut Client, channel: Uuid, after: i64) {
    control(
        client,
        ClientMessage::Unsubscribe {
            channel_id: channel,
        },
    )
    .await
    .unwrap();
    subscribe(client, channel, after).await;
}
fn is_notice(frame: &tungstenite::Message) -> bool {
    let tungstenite::Message::Text(text) = frame else {
        return false;
    };
    serde_json::from_str::<crate::channels::activity::Notice>(text).is_ok()
}
pub(super) async fn message_next(
    client: &mut Client,
) -> Option<Result<tungstenite::Message, tungstenite::Error>> {
    loop {
        let result = client.next().await?;
        if result.as_ref().is_ok_and(is_notice) {
            continue;
        }
        return Some(result);
    }
}
pub(super) async fn frame(client: &mut Client) -> tungstenite::Message {
    tokio::time::timeout(Duration::from_secs(5), message_next(client))
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}
pub(super) async fn delivery_next<S>(
    client: &mut WebSocketStream<S>,
    expected_pong: Option<&[u8]>,
) -> Option<Result<tungstenite::Message, tungstenite::Error>>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        let result =
            crate::websocket_test_support::websocket_delivery_next(client, expected_pong).await?;
        if result.as_ref().is_ok_and(is_notice) {
            continue;
        }
        return Some(result);
    }
}
pub(super) async fn delivery_frame(client: &mut Client) -> tungstenite::Message {
    tokio::time::timeout(Duration::from_secs(5), delivery_next(client, None))
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}
pub(super) async fn event(client: &mut Client) -> Value {
    tokio::time::timeout(Duration::from_secs(5), read_event(client))
        .await
        .unwrap()
}
pub(super) async fn read_event(client: &mut Client) -> Value {
    loop {
        match message_next(client).await.unwrap().unwrap() {
            tungstenite::Message::Ping(_) => client.flush().await.unwrap(),
            tungstenite::Message::Text(text) => {
                return serde_json::from_str(&text).unwrap_or_else(|error| {
                    panic!("expected JSON event, got Text({text:?}): {error}")
                });
            }
            tungstenite::Message::Close(Some(close)) => panic!(
                "expected JSON event, got Close(code={}, reason={:?})",
                u16::from(close.code),
                close.reason.as_str()
            ),
            frame => panic!("expected JSON event, got {frame:?}"),
        }
    }
}
pub(super) async fn ready(client: &mut Client, channel: Uuid, seq: i64) {
    let mut subscribed = event(client).await;
    assert!(Uuid::parse_str(subscribed["history_generation"].as_str().unwrap()).is_ok());
    subscribed
        .as_object_mut()
        .unwrap()
        .remove("history_generation");
    assert_eq!(
        subscribed,
        json!({"type":"subscribed", "channel_id":channel, "caught_up_seq":seq})
    );
}
pub(super) async fn denied(client: &mut Client, channel: Uuid) {
    assert_eq!(
        event(client).await,
        json!({"type":"error", "channel_id":channel, "code":"channel_not_found"})
    );
}
pub(super) async fn silent<S>(client: &mut WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let result =
        tokio::time::timeout(Duration::from_millis(100), delivery_next(client, None)).await;
    assert!(result.is_err(), "expected delivery silence, got {result:?}");
}
pub(super) async fn closed(client: &mut Client, code: u16) {
    let frame = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match frame(client).await {
                tungstenite::Message::Ping(_) => client.flush().await.unwrap(),
                frame => break frame,
            }
        }
    })
    .await
    .unwrap();
    let tungstenite::Message::Close(Some(close)) = &frame else {
        panic!("expected Close(code={code}), got {frame:?}");
    };
    assert_eq!(u16::from(close.code), code, "got {frame:?}");
}
pub(super) fn rejected(result: Result<Client, tungstenite::Error>, status: u16) {
    let Err(tungstenite::Error::Http(response)) = result else {
        panic!("expected HTTP denial");
    };
    assert_eq!(response.status(), status);
    let body: Value = serde_json::from_slice(response.body().as_ref().unwrap()).unwrap();
    assert!(body["error"].is_string());
}
