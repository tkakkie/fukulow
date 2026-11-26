use super::*;

mod access_loss;
mod archive;
mod batching;
mod channel_notices;
mod directory;
mod dms;
mod fences;
mod process;
mod publication;
mod read_positions;
mod rechecks;
mod recipients;
mod revocations;
mod sections;
mod stream;
mod upgrade;

async fn raw_event(socket: &mut Client) -> Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        {
            tungstenite::Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            tungstenite::Message::Ping(_) => socket.flush().await.unwrap(),
            other => panic!("expected notice, got {other:?}"),
        }
    }
}
async fn connect(f: &Fixture, token: &str) -> Client {
    let mut socket = f.server.connect(token).await;
    assert_eq!(
        raw_event(&mut socket).await,
        json!({"type":"activity_ready"})
    );
    socket
}
async fn notices(f: &Fixture, socket: &mut Client) -> Vec<Value> {
    collect(&f.state.message_delivery.channel_access.activity, socket).await
}
pub(super) async fn collect(
    delivery: &crate::channels::activity::Activity,
    socket: &mut Client,
) -> Vec<Value> {
    // All counted publishers must finish; callers separately join direct publish futures.
    delivery.drained().await;
    let nonce = Uuid::new_v4().as_bytes().to_vec();
    // With publishers done and gates released, run's biased activity-before-recv polls put Pong after the buffer.
    socket
        .send(tungstenite::Message::Ping(nonce.clone().into()))
        .await
        .unwrap();
    let mut result = Vec::new();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        match frame {
            tungstenite::Message::Pong(bytes) if bytes.as_ref() == nonce => return result,
            tungstenite::Message::Ping(_) => socket.flush().await.unwrap(),
            tungstenite::Message::Text(text) => {
                let notice: Value = serde_json::from_str(&text).unwrap();
                assert!(
                    serde_json::from_value::<crate::channels::activity::Notice>(notice.clone())
                        .is_ok(),
                    "unexpected body/personal data: {notice}"
                );
                result.push(notice);
            }
            other => panic!("unexpected activity frame: {other:?}"),
        }
    }
}
async fn grant(pool: &PgPool, f: &Fixture, channel: Uuid, target: Uuid) {
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
    )
    .bind(f.organization)
    .bind(channel)
    .bind(target)
    .execute(pool)
    .await
    .unwrap();
}
async fn owner(pool: &PgPool, f: &Fixture) {
    sqlx::query("UPDATE users SET role='owner' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(f.member)
        .execute(pool)
        .await
        .unwrap();
}
async fn role(pool: &PgPool, f: &Fixture, target: Uuid, value: &str) {
    sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(target)
        .bind(value)
        .execute(pool)
        .await
        .unwrap();
}
fn activity(channel: Uuid, seq: i64) -> Value {
    json!({"type":"channel_activity","channel_id":channel,"seq":seq})
}

pub(super) async fn raw_closed(socket: &mut Client, code: u16) {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        {
            tungstenite::Message::Close(Some(frame)) => {
                assert_eq!(u16::from(frame.code), code);
                return;
            }
            tungstenite::Message::Ping(_) => socket.flush().await.unwrap(),
            frame => panic!("denied socket received protected data before close: {frame:?}"),
        }
    }
}
