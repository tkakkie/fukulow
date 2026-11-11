use super::*;
use futures_util::FutureExt;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Failure {
    PublicMembers(String),
    Chain {
        step: usize,
    },
    Timeline {
        step: usize,
    },
    Unread {
        step: usize,
    },
    Expectation {
        step: usize,
        event: usize,
        assertion: Assertion,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Assertion {
    Message,
    EmptyMessage,
    EmptyChannel,
    Subscribed,
    Error,
    Closed,
    Silence,
    Read,
}

async fn read(client: &mut Client) -> Result<tungstenite::Message, Assertion> {
    match tokio::time::timeout(Duration::from_secs(5), client.next()).await {
        Ok(Some(Ok(frame))) => Ok(frame),
        other => {
            eprintln!("contract read failed: {other:?}");
            Err(Assertion::Read)
        }
    }
}

pub(super) async fn json(
    client: &mut Client,
    expected: Value,
    assertion: Assertion,
) -> Result<(), Assertion> {
    let frame = read(client).await?;
    let actual = match &frame {
        tungstenite::Message::Text(text) => serde_json::from_str::<Value>(text).ok(),
        _ => None,
    };
    if actual.as_ref() != Some(&expected) {
        eprintln!("{assertion:?}: expected {expected}, got {frame:?}");
        return Err(assertion);
    }
    Ok(())
}

pub(super) async fn closed(client: &mut Client, code: u16) -> Result<(), Assertion> {
    let frame = read(client).await?;
    if !matches!(&frame, tungstenite::Message::Close(Some(close)) if u16::from(close.code) == code)
    {
        eprintln!("expected close {code}, got {frame:?}");
        return Err(Assertion::Closed);
    }
    Ok(())
}

pub(super) async fn silence(
    client: &mut Client,
    channel: Uuid,
    caught_up_seq: i64,
) -> Result<(), Assertion> {
    // Reject an already readable event/close before writing on a possibly closed
    // socket. Absence here proves nothing; only the drain barrier below does.
    if let Some(frame) = client.next().now_or_never() {
        eprintln!("unexpected traffic before silence barrier: {frame:?}");
        return match frame {
            Some(Ok(_)) => Err(Assertion::Silence),
            _ => Err(Assertion::Read),
        };
    }
    // Runner awaited all detached notification tasks before entering this barrier.
    // All fixture posts (including concurrent ones) have returned and enqueued.
    // Connection::control(Subscribe) runs serially with live delivery, snapshots the
    // shared FIFO queue length and awaits live() for that whole prefix before sending
    // subscribed. This drains *all* Channels, even a wrongly enqueued denial/duplicate.
    // Replay and sends in progress on this connection must also finish before control.
    // A nonce ping follows the control on the same ordered stream. Its pong proves
    // this subscribe ran; an old duplicate subscribed cannot impersonate the barrier.
    // TCP preserves frame order. Thus any earlier wrong send, even if live() takes
    // >100 ms, precedes this response and fails here. A cross-Channel live Message or
    // an error response alone would not drain the queue and is not a valid barrier.
    // Close paths are covered too: connected() polls session end (4001) and overflow
    // (4008) before connection.run() in a biased select. Overflow is signalled before
    // notification completion, so a pending close wins over processing this barrier.
    // Use the fixture's authorized Channel/current watermark: no new replay, and do
    // not restore the subscription/access whose absence is being checked.
    let nonce = barrier_controls(client, channel, caught_up_seq).await?;
    json(
        client,
        json!({"type":"subscribed","channel_id":channel,"caught_up_seq":caught_up_seq}),
        Assertion::Silence,
    )
    .await?;
    let frame = read(client).await?;
    if frame != tungstenite::Message::Pong(nonce.into()) {
        eprintln!("expected barrier pong, got {frame:?}");
        return Err(Assertion::Silence);
    }
    Ok(())
}

// Keep both writes fallible: a close can race after silence's initial read poll.
pub(super) async fn barrier_controls(
    client: &mut (impl futures_util::Sink<tungstenite::Message, Error = tungstenite::Error> + Unpin),
    channel: Uuid,
    caught_up_seq: i64,
) -> Result<Vec<u8>, Assertion> {
    control(
        client,
        ClientMessage::Subscribe {
            channel_id: channel,
            after_seq: caught_up_seq,
        },
    )
    .await
    .map_err(|_| Assertion::Silence)?;
    let nonce = Uuid::new_v4().as_bytes().to_vec();
    client
        .send(tungstenite::Message::Ping(nonce.clone().into()))
        .await
        .map_err(|_| Assertion::Silence)?;
    Ok(nonce)
}
