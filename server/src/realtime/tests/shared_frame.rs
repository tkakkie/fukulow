use super::*;
use std::sync::atomic::Ordering;

#[fukulow_test::test]
async fn live_serialization_is_once_per_fanout_including_shared_gap_recovery(pool: PgPool) {
    for recipients in [0, 1, 4] {
        let f = fixture(&pool).await;
        let delivery = &f.state.message_delivery;
        let mut sockets = Vec::new();
        for _ in 0..recipients {
            let mut socket = f.server.connect(&f.token).await;
            subscribe(&mut socket, f.channel, 0).await;
            ready(&mut socket, f.channel, 0).await;
            sockets.push(socket);
        }
        let first = send(&f, &f.token, f.channel, Uuid::new_v4(), "ordinary live").await;
        delivery.flush().await;
        for socket in &mut sockets {
            assert_eq!(event(socket).await["message"], first);
        }
        let expected = usize::from(recipients != 0);
        assert_eq!(
            delivery.message_serializations.load(Ordering::Relaxed),
            expected
        );

        let key = Uuid::new_v4();
        let gate = messages::pause_publication(key);
        let recovered = send(&f, &f.token, f.channel, key, "recovered prefix").await;
        gate.entered().await;
        let later = send(&f, &f.token, f.channel, Uuid::new_v4(), "publishes first").await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while delivery.publication_cursor(f.organization, f.channel).await != Some(3) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        for socket in &mut sockets {
            assert_eq!(event(socket).await["message"], recovered);
            assert_eq!(event(socket).await["message"], later);
        }
        assert_eq!(
            delivery.message_serializations.load(Ordering::Relaxed),
            3 * expected
        );
        assert_eq!(delivery.live_refills.load(Ordering::Relaxed), 0);
        gate.release.add_permits(1);
        delivery.flush().await;
        // The delayed duplicate publication must neither serialize nor deliver again.
        let last = send(&f, &f.token, f.channel, Uuid::new_v4(), "after duplicate").await;
        delivery.flush().await;
        for socket in &mut sockets {
            assert_eq!(event(socket).await["message"], last);
            silent(socket).await;
        }
        assert_eq!(
            delivery.message_serializations.load(Ordering::Relaxed),
            4 * expected
        );
    }
}

#[test]
#[ignore = "manual release microbenchmark; no database or sockets"]
fn measure_live_frame_serialization_and_sharing() {
    use std::{hint::black_box, time::Instant};
    let message = messages::Message {
        history_generation: uuid::Uuid::nil(),
        id: Uuid::new_v4(),
        channel_id: Uuid::new_v4(),
        created_seq: 2,
        version: 2,
        deleted: false,
        client_message_id: Uuid::new_v4(),
        sender: Uuid::new_v4(),
        body: Some("日本語 \"quoted\"\\\n".repeat(64)),
        created_at: "2026-11-15T00:00:00Z".into(),
        topic_id: Some(Uuid::new_v4()),
        reply_to: Some(Uuid::new_v4()),
        reply_root_id: Some(Uuid::new_v4()),
        mentions: Some(vec![messages::Mention {
            member_id: Uuid::new_v4(),
            name: "Current name".into(),
        }]),
    };
    eprintln!(
        "body_bytes={} frame_bytes={}",
        message.body.as_ref().unwrap().len(),
        messages::LiveMessage::new(message.clone())
            .unwrap()
            .frame
            .len()
    );
    for (recipients, rounds) in [(1, 10_000), (128, 1_000), (10_000, 30)] {
        for trial in 0..5 {
            // Alternate order to expose rather than select away warm-up/order effects.
            for shared in if trial % 2 == 0 {
                [false, true]
            } else {
                [true, false]
            } {
                let start = Instant::now();
                for _ in 0..rounds {
                    if shared {
                        let live = Arc::new(messages::LiveMessage::new(message.clone()).unwrap());
                        for _ in 0..recipients {
                            let queued = black_box(live.clone());
                            black_box(queued.frame.clone());
                        }
                    } else {
                        let live = Arc::new(message.clone());
                        for _ in 0..recipients {
                            let queued = black_box(live.clone());
                            let event = ServerEvent::Message {
                                seq: 2,
                                kind: fukulow_api::MessageStateKind::Create,
                                message: (*queued).clone(),
                            };
                            let json = serde_json::to_string(&event).unwrap();
                            black_box(axum::extract::ws::Utf8Bytes::from(json));
                        }
                    }
                }
                eprintln!(
                    "recipients={recipients} rounds={rounds} trial={trial} shared={shared} us_per_fanout={:.3}",
                    start.elapsed().as_secs_f64() * 1e6 / f64::from(rounds)
                );
            }
        }
    }
}

#[fukulow_test::test]
async fn shared_live_frame_matches_old_json_bytes_with_topic_reply_and_refreshed_mentions(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let root = topics::topic_send(&f, &f.token, f.channel, Uuid::new_v4()).await;
    f.state.message_delivery.flush().await;
    let mut queues = Vec::new();
    for _ in 0..2 {
        let mut queue = f
            .state
            .message_delivery
            .queue(f.organization, (f.member, 0), 4);
        queue.subscribe(f.channel);
        queues.push(queue);
    }
    let mut sockets = Vec::new();
    for _ in 0..3 {
        let mut socket = f.server.connect(&f.token).await;
        subscribe(&mut socket, f.channel, 1).await;
        ready(&mut socket, f.channel, 1).await;
        sockets.push(socket);
    }
    let key = Uuid::new_v4();
    let gate = messages::pause_publication(key);
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/channels/{}/messages", f.channel),
        &f.token,
        json!({"client_message_id": key, "body": format!("日本語 \"quoted\"\\\n@{{member:{}}}", f.member), "reply_to": root["id"]}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let ack: messages::Message =
        serde_json::from_slice(&to_bytes(response.into_body(), 32 * 1024).await.unwrap()).unwrap();
    gate.entered().await;
    assert_eq!(ack.mentions.as_ref().unwrap()[0].name, "Member");
    sqlx::query("UPDATE users SET name=$1 WHERE organization_id=$2 AND id=$3")
        .bind("現在の名前 \"quoted\"\\\n")
        .bind(f.organization)
        .bind(f.member)
        .execute(&pool)
        .await
        .unwrap();
    gate.release.add_permits(1);
    f.state.message_delivery.flush().await;
    let enriched = queues[0].events.try_recv().unwrap();
    assert!(Arc::ptr_eq(
        &enriched,
        &queues[1].events.try_recv().unwrap()
    ));
    assert_eq!(
        enriched.message().topic_id,
        Some(serde_json::from_value(root["topic_id"].clone()).unwrap())
    );
    assert_eq!(
        enriched.message().reply_to,
        Some(serde_json::from_value(root["id"].clone()).unwrap())
    );
    assert_eq!(
        enriched.message().reply_root_id,
        enriched.message().reply_to
    );
    assert_eq!(
        enriched.message().mentions.as_ref().unwrap()[0].member_id,
        f.member
    );
    assert_eq!(
        enriched.message().mentions.as_ref().unwrap()[0].name,
        "現在の名前 \"quoted\"\\\n"
    );
    // Exact old per-connection expression, on the same delivery_snapshot Message.
    let old = serde_json::to_string(&ServerEvent::Message {
        seq: enriched.seq,
        kind: fukulow_api::MessageStateKind::Create,
        message: enriched.message().clone(),
    })
    .unwrap();
    assert_eq!(enriched.frame.as_bytes(), old.as_bytes());
    for socket in &mut sockets {
        let tungstenite::Message::Text(raw) = delivery_frame(socket).await else {
            panic!("expected live text frame");
        };
        assert_eq!(raw.as_bytes(), old.as_bytes());
    }
}
