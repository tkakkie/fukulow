use super::*;

#[fukulow_test::test]
async fn two_senders_coalesce_without_losing_each_others_activity(pool: PgPool) {
    for reverse in [false, true] {
        let f = fixture(&pool).await;
        let (bob, bob_token) = member(&pool, f.organization).await;
        let (third_id, third_token) = member(&pool, f.organization).await;
        let (_, denied_token) = member(&pool, f.organization).await;
        let private = channel(&pool, f.organization, f.member, true).await;
        grant(&pool, &f, private, bob).await;
        grant(&pool, &f, private, third_id).await;
        let alice_other = session::another_session(&pool, f.organization, f.member).await;
        let bob_other = session::another_session(&pool, f.organization, bob).await;
        let mut alice = connect(&f, &f.token).await;
        let mut alice2 = connect(&f, &alice_other).await;
        let mut bob1 = connect(&f, &bob_token).await;
        let mut bob2 = connect(&f, &bob_other).await;
        let mut third = connect(&f, &third_token).await;
        let mut denied = connect(&f, &denied_token).await;
        let (first, second) = if reverse {
            (&bob_token, &f.token)
        } else {
            (&f.token, &bob_token)
        };
        let gate = crate::channels::activity::pause(f.organization, private, "authorized");
        send(&f, first, private, Uuid::new_v4(), "First").await;
        gate.entered().await;
        send(&f, second, private, Uuid::new_v4(), "Second").await;
        gate.release();
        for socket in [&mut alice, &mut alice2] {
            assert_eq!(
                notices(&f, socket).await,
                vec![activity(private, if reverse { 1 } else { 2 })]
            );
        }
        for socket in [&mut bob1, &mut bob2] {
            assert_eq!(
                notices(&f, socket).await,
                vec![activity(private, if reverse { 2 } else { 1 })]
            );
        }
        assert_eq!(
            notices(&f, &mut third).await.last(),
            Some(&activity(private, 2))
        );
        assert!(notices(&f, &mut denied).await.is_empty());
    }
}

async fn batch_measurement(pool: &PgPool, readers: usize) -> Value {
    let f = fixture(pool).await;
    let (bob, bob_token) = member(pool, f.organization).await;
    let (_, reader_token) = member(pool, f.organization).await;
    let alice_other = session::another_session(pool, f.organization, f.member).await;
    let bob_other = session::another_session(pool, f.organization, bob).await;
    let mut sockets = Vec::new();
    for token in [&f.token, &alice_other, &bob_token, &bob_other] {
        sockets.push((
            connect(&f, token).await,
            if token == &f.token || token == &alice_other {
                4
            } else {
                3
            },
        ));
    }
    for _ in 0..readers {
        sockets.push((connect(&f, &reader_token).await, 4));
    }
    let gate = crate::channels::activity::pause(f.organization, f.channel, "authorized");
    post(&f, f.channel).await;
    gate.entered().await;
    send(&f, &bob_token, f.channel, Uuid::new_v4(), "Bob 2").await;
    post(&f, f.channel).await;
    send(&f, &bob_token, f.channel, Uuid::new_v4(), "Bob 4").await;
    let start = std::time::Instant::now();
    gate.release();
    let mut tasks = tokio::task::JoinSet::new();
    for (mut socket, expected) in sockets {
        tasks.spawn(async move {
            loop {
                let event = raw_event(&mut socket).await;
                assert_eq!(event["type"], "channel_activity");
                assert_eq!(event["channel_id"], f.channel.to_string());
                if event["seq"] == expected {
                    return start.elapsed().as_micros() as u64;
                }
            }
        });
    }
    let mut micros = Vec::new();
    while let Some(result) = tasks.join_next().await {
        micros.push(result.unwrap());
    }
    f.state
        .message_delivery
        .channel_access
        .activity
        .drained()
        .await;
    let queries = f
        .state
        .message_delivery
        .channel_access
        .activity
        .queries
        .load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(queries, 2, "one frozen query and one pending batch");
    micros.sort_unstable();
    let at = |p: usize| micros[(micros.len() * p).div_ceil(100) - 1];
    json!({"reader_sockets":readers,"sender_sockets":4,"committed_sends":4,"recipient_queries":queries,"release_to_final_notice_us":{"p50":at(50),"p95":at(95),"p99":at(99),"max":micros.last()},"app_pool_max":f.state.pool.options().get_max_connections()})
}
#[fukulow_test::test]
async fn messages_after_authorization_snapshot_get_a_fresh_batch(pool: PgPool) {
    batch_measurement(&pool, 1).await;
}
#[fukulow_test::test]
#[ignore = "manual release multi-sender coalescing measurement, separate from periodic REST load"]
async fn measure_multi_sender_activity_batching(pool: PgPool) {
    eprintln!(
        "ACTIVITY_BATCH_MEASUREMENT {}",
        batch_measurement(&pool, 1000).await
    );
}

#[fukulow_test::test]
async fn moves_share_one_pending_activity_batch_and_notify_the_mover(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (_, sender) = member(&pool, f.organization).await;
    let root = send(&f, &sender, f.channel, Uuid::new_v4(), "Move this").await;
    let activity = &f.state.message_delivery.channel_access.activity;
    activity.drained().await;
    let mut mover = connect(&f, &f.token).await;
    let mut reader = connect(&f, &sender).await;
    let initial = activity.queries.load(std::sync::atomic::Ordering::SeqCst);
    let pause = crate::channels::activity::pause(f.organization, f.channel, "query");
    for expected_version in 1..=3 {
        let response = request(
            &f.app,
            "POST",
            &format!("/api/v1/channels/{}/messages/{}/move", f.channel, root["id"].as_str().unwrap()),
            &f.token,
            json!({"operation_id":Uuid::new_v4(),"expected_version":expected_version,"topic_name":format!("Topic {expected_version}")}),
        ).await;
        assert_eq!(response.status(), StatusCode::OK);
        if expected_version == 1 {
            pause.entered().await;
        }
    }
    activity.drained_except(1).await;
    assert_eq!(
        activity.queries.load(std::sync::atomic::Ordering::SeqCst),
        initial
    );
    pause.release();
    for socket in [&mut mover, &mut reader] {
        let events = notices(&f, socket).await;
        assert_eq!(
            events.last(),
            Some(&json!({"type":"channel_activity","channel_id":f.channel,"seq":4}))
        );
        assert!(
            events
                .iter()
                .all(|notice| notice["seq"] == 2 || notice["seq"] == 4)
        );
    }
    assert_eq!(
        activity.queries.load(std::sync::atomic::Ordering::SeqCst),
        initial + 2
    );
}
