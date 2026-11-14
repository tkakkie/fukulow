use super::*;

#[fukulow_test::test]
async fn reply_inherits_root_and_topic_and_retry_compares_parent_before_lookup(pool: PgPool) {
    let (app, org, _, channel, token) = fixture(&pool).await;
    for topic in [None, Some("Release")] {
        let mut input = input(Uuid::new_v4(), "Root");
        input["topic_name"] = json!(topic);
        let root = sent(&app, &token, channel, input).await;
        assert!(root["reply_to"].is_null() && root["reply_root_id"].is_null());
        let key = Uuid::new_v4();
        let intent = reply_input(key, &root);
        let first = sent(&app, &token, channel, intent.clone()).await;
        assert_eq!(first["reply_to"], root["id"]);
        assert_eq!(first["reply_root_id"], root["id"]);
        assert_eq!(first["topic_id"], root["topic_id"]);
        let child = sent(&app, &token, channel, reply_input(Uuid::new_v4(), &first)).await;
        assert_eq!(child["reply_to"], first["id"]);
        assert_eq!(child["reply_root_id"], root["id"]);
        assert_eq!(child["topic_id"], root["topic_id"]);
        assert_eq!(sent(&app, &token, channel, intent.clone()).await, first);
        let mut null_topic = intent.clone();
        null_topic["topic_name"] = Value::Null;
        assert_eq!(sent(&app, &token, channel, null_topic).await, first);
        for changed in [
            input_without_parent(key),
            reply_input(key, &child),
            json!({"client_message_id":key,"body":"Reply payload","reply_to":Uuid::new_v4()}),
            json!({"client_message_id":key,"body":"changed","reply_to":root["id"]}),
            reply_input(
                root["client_message_id"].as_str().unwrap().parse().unwrap(),
                &first,
            ),
        ] {
            assert_error(
                send(&app, &token, channel, changed).await,
                StatusCode::CONFLICT,
            )
            .await;
        }
        // Even a conflicting key and missing parent cannot hide invalid selector combinations.
        for name in ["Release", "", " ", "\0"] {
            let mut invalid = intent.clone();
            invalid["reply_to"] = json!(Uuid::new_v4());
            invalid["topic_name"] = json!(name);
            error(
                send(&app, &token, Uuid::new_v4(), invalid).await,
                StatusCode::BAD_REQUEST,
                "reply_topic_not_allowed",
            )
            .await;
        }
    }
    assert_eq!(counts(&pool, org, channel).await, (6, 6, 3));
    let mut null_parent = input_without_parent(Uuid::new_v4());
    null_parent["reply_to"] = Value::Null;
    let plain = sent(&app, &token, channel, null_parent).await;
    assert!(plain["reply_to"].is_null() && plain["reply_root_id"].is_null());
}

fn input_without_parent(key: Uuid) -> Value {
    input(key, "Reply payload")
}

#[fukulow_test::test]
async fn reply_concurrent_duplicates_and_cross_channel_conflict_consume_one_seq_and_count(
    pool: PgPool,
) {
    let (_, org, sender, channel, token) = fixture(&pool).await;
    let state = AppState::for_test(pool.clone()).await;
    let delivery = state.message_delivery.clone();
    let app = crate::app(state);
    let root = sent(
        &app,
        &token,
        channel,
        topics::topic_input(Uuid::new_v4(), "Release"),
    )
    .await;
    delivery.flush().await;
    let mut queue = delivery.queue(org, (sender, 0), 256);
    queue.subscribe(channel);
    let key = Uuid::new_v4();
    let mut jobs = tokio::task::JoinSet::new();
    for _ in 0..16 {
        let (app, token, root) = (app.clone(), token.clone(), root.clone());
        jobs.spawn(async move { sent(&app, &token, channel, reply_input(key, &root)).await });
    }
    let mut canonical = None;
    while let Some(result) = jobs.join_next().await {
        let m = result.unwrap();
        if let Some(first) = &canonical {
            assert_eq!(&m, first);
        } else {
            canonical = Some(m);
        }
    }
    let canonical = canonical.unwrap();
    assert_eq!(canonical["seq"], 2);
    assert_eq!(counts(&pool, org, channel).await, (2, 2, 2));
    delivery.flush().await;
    assert_eq!(
        serde_json::to_value(queue.events.try_recv().unwrap()).unwrap(),
        canonical
    );
    assert!(queue.events.try_recv().is_err());
    let other = Uuid::new_v4();
    super::super::channel(&pool, org, other, sender, false).await;
    let other_root = sent(&app, &token, other, input(Uuid::new_v4(), "Other root")).await;
    let race_key = Uuid::new_v4();
    let (a, b) = tokio::join!(
        send(&app, &token, channel, reply_input(race_key, &root)),
        send(&app, &token, other, reply_input(race_key, &other_root))
    );
    let statuses = [a.status(), b.status()];
    assert!(statuses.contains(&StatusCode::CREATED) && statuses.contains(&StatusCode::CONFLICT));
    assert_eq!(
        counts(&pool, org, channel).await.0 + counts(&pool, org, other).await.0,
        4
    );
    assert_eq!(
        counts(&pool, org, channel).await.1 + counts(&pool, org, other).await.1,
        4
    );
}
