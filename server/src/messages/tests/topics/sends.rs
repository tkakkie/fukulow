use super::*;

#[sqlx::test]
async fn topic_names_validate_scalars_whitespace_and_channel_scoped_ascii_identity(pool: PgPool) {
    let (app, org, sender, channel, token) = fixture(&pool).await;
    for name in [
        "".into(),
        " \t\n".into(),
        "a\0b".into(),
        " leading".into(),
        "trailing\n".into(),
        "\u{2003}名".into(),
        "名\u{a0}".into(),
        "🦉".repeat(61),
    ] {
        assert_error(
            send(&app, &token, channel, topic_input(Uuid::new_v4(), &name)).await,
            StatusCode::BAD_REQUEST,
        )
        .await;
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM topics WHERE organization_id=$1")
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM channel_message_sequences WHERE organization_id=$1"
        )
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    let first = sent(
        &app,
        &token,
        channel,
        topic_input(Uuid::new_v4(), "Release A"),
    )
    .await;
    let folded = sent(
        &app,
        &token,
        channel,
        topic_input(Uuid::new_v4(), "rELEASE a"),
    )
    .await;
    assert_eq!(first["topic_id"], folded["topic_id"]);
    let id = first["topic_id"].as_str().unwrap();
    assert_eq!(
        get(&app, &token, channel, &format!("topics/{id}")).await["topic"]["name"],
        "Release A"
    );
    let other = Uuid::new_v4();
    super::super::channel(&pool, org, other, sender, false).await;
    let separate = sent(
        &app,
        &token,
        other,
        topic_input(Uuid::new_v4(), "Release A"),
    )
    .await;
    assert_ne!(first["topic_id"], separate["topic_id"]);
    for name in [
        "日本語 内部",
        "🦉".repeat(60).as_str(),
        "e\u{301}",
        "É",
        "é",
    ] {
        let m = sent(&app, &token, channel, topic_input(Uuid::new_v4(), name)).await;
        let summary = get(
            &app,
            &token,
            channel,
            &format!("topics/{}", m["topic_id"].as_str().unwrap()),
        )
        .await;
        assert_eq!(summary["topic"]["name"], name);
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM topics WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(org)
    .bind(channel)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 6,
        "non-ASCII case and combining sequences are not normalized"
    );
    let schema =
        serde_json::to_value(<crate::openapi::ApiDoc as utoipa::OpenApi>::openapi()).unwrap();
    let name = &schema["components"]["schemas"]["SendMessageRequest"]["properties"]["topic_name"];
    assert_eq!(name["minLength"], 1);
    assert_eq!(name["maxLength"], 60);
}

#[sqlx::test]
async fn topic_concurrent_first_sends_resends_and_lost_response_are_exactly_once(pool: PgPool) {
    let (_, org, sender, channel, token) = fixture(&pool).await;
    let second = member(&pool, org, Uuid::new_v4()).await;
    let state = AppState::for_test(pool.clone()).await;
    let delivery = state.message_delivery.clone();
    let mut queue = delivery.queue(org, (sender, 0), 256);
    queue.subscribe(channel);
    let app = crate::app(state);
    let mut jobs = tokio::task::JoinSet::new();
    for n in 0..16 {
        let (app, token) = (
            app.clone(),
            if n % 2 == 0 {
                token.clone()
            } else {
                second.clone()
            },
        );
        jobs.spawn(async move {
            sent(
                &app,
                &token,
                channel,
                topic_input(
                    Uuid::new_v4(),
                    if n % 2 == 0 { "Release" } else { "RELEASE" },
                ),
            )
            .await
        });
    }
    let mut messages = Vec::new();
    while let Some(result) = jobs.join_next().await {
        messages.push(result.unwrap());
    }
    let topic = messages[0]["topic_id"].clone();
    assert!(messages.iter().all(|m| m["topic_id"] == topic));
    let duplicate = Uuid::new_v4();
    for n in 0..16 {
        let (app, token) = (app.clone(), token.clone());
        jobs.spawn(async move {
            sent(
                &app,
                &token,
                channel,
                topic_input(duplicate, if n % 2 == 0 { "release" } else { "Release" }),
            )
            .await
        });
    }
    let mut duplicate_messages = Vec::new();
    while let Some(result) = jobs.join_next().await {
        duplicate_messages.push(result.unwrap());
    }
    assert!(
        duplicate_messages
            .iter()
            .all(|m| m == &duplicate_messages[0])
    );
    assert_eq!(duplicate_messages[0]["seq"], 17);
    let lost = Uuid::new_v4();
    let response = send(&app, &token, channel, topic_input(lost, "release")).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    drop(response); // The client never obtained the Topic UUID or ACK.
    let recovered = sent(&app, &token, channel, topic_input(lost, "RELEASE")).await;
    assert_eq!(recovered["seq"], 18);
    assert_eq!(recovered["topic_id"], topic);
    assert_eq!(
        get(
            &app,
            &token,
            channel,
            &format!("topics/{}", topic.as_str().unwrap())
        )
        .await["topic"]["message_count"],
        18
    );
    let counts: (i64, i64, i64) = sqlx::query_as("SELECT (SELECT count(*) FROM topics WHERE organization_id=$1), (SELECT count(*) FROM messages WHERE organization_id=$1), (SELECT seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2)")
        .bind(org).bind(channel).fetch_one(&pool).await.unwrap();
    assert_eq!(counts, (1, 18, 18));
    delivery.flush().await;
    for seq in 1..=18 {
        assert_eq!(queue.events.try_recv().unwrap().seq, seq);
    }
    assert!(queue.events.try_recv().is_err(), "retries never publish");
}

#[sqlx::test]
async fn topic_retry_identity_rejects_added_removed_changed_and_cross_channel_intent(pool: PgPool) {
    let (app, org, sender, channel, token) = fixture(&pool).await;
    let key = Uuid::new_v4();
    let canonical = sent(&app, &token, channel, topic_input(key, "First")).await;
    assert_eq!(
        sent(&app, &token, channel, topic_input(key, "FIRST")).await,
        canonical
    );
    for value in [
        input(key, "Topic Message"),
        topic_input(key, "Changed"),
        json!({"client_message_id":key,"body":"changed","topic_name":"First"}),
    ] {
        assert_error(
            send(&app, &token, channel, value).await,
            StatusCode::CONFLICT,
        )
        .await;
    }
    let plain_key = Uuid::new_v4();
    sent(&app, &token, channel, input(plain_key, "Topic Message")).await;
    assert_error(
        send(&app, &token, channel, topic_input(plain_key, "First")).await,
        StatusCode::CONFLICT,
    )
    .await;
    let other = Uuid::new_v4();
    super::super::channel(&pool, org, other, sender, false).await;
    assert_error(
        send(&app, &token, other, topic_input(key, "First")).await,
        StatusCode::CONFLICT,
    )
    .await;
    assert_eq!(
        get(&app, &token, other, "topics").await["topics"],
        json!([])
    );
    assert_eq!(
        get(&app, &token, channel, "topics").await["topics"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        list(&app, &token, channel, "").await["messages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let null = sent(
        &app,
        &token,
        channel,
        json!({"client_message_id":Uuid::new_v4(),"body":"null Topic", "topic_name":null}),
    )
    .await;
    assert!(null["topic_id"].is_null());
    assert_eq!(null["seq"], 3);
}

#[sqlx::test]
async fn topic_first_creation_duplicates_lost_ack_and_cross_channel_race_leave_no_empty_topic(
    pool: PgPool,
) {
    let (_, org, sender, channel, token) = fixture(&pool).await;
    let state = AppState::for_test(pool.clone()).await;
    let delivery = state.message_delivery.clone();
    let app = crate::app(state);
    let other = Uuid::new_v4();
    super::super::channel(&pool, org, other, sender, false).await;
    let mut queue = delivery.queue(org, (sender, 0), 256);
    queue.subscribe(channel);
    queue.subscribe(other);
    let key = Uuid::new_v4();
    let mut jobs = tokio::task::JoinSet::new();
    for n in 0..16 {
        let app = app.clone();
        let token = token.clone();
        jobs.spawn(async move {
            sent(
                &app,
                &token,
                channel,
                topic_input(
                    key,
                    if n % 2 == 0 {
                        "First creation"
                    } else {
                        "FIRST CREATION"
                    },
                ),
            )
            .await
        });
    }
    let mut first = None;
    while let Some(result) = jobs.join_next().await {
        let m = result.unwrap();
        if let Some(first) = &first {
            assert_eq!(&m, first);
        } else {
            first = Some(m);
        }
    }
    assert_eq!(first.unwrap()["seq"], 1);
    let lost = Uuid::new_v4();
    let response = send(&app, &token, channel, topic_input(lost, "Lost creation")).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    drop(response);
    let recovered = sent(&app, &token, channel, topic_input(lost, "LOST CREATION")).await;
    assert_eq!(recovered["seq"], 2);
    let race = Uuid::new_v4();
    let (left, right) = tokio::join!(
        send(&app, &token, channel, topic_input(race, "Raced creation")),
        send(&app, &token, other, topic_input(race, "Raced creation"))
    );
    let statuses = [left.status(), right.status()];
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::CREATED)
            .count(),
        1
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::CONFLICT)
            .count(),
        1
    );
    let state:(i64,i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM topics WHERE organization_id=$1), (SELECT count(*) FROM messages WHERE organization_id=$1), (SELECT sum(seq)::bigint FROM channel_message_sequences WHERE organization_id=$1), (SELECT sum(message_count)::bigint FROM topics WHERE organization_id=$1)")
        .bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(state, (3, 3, 3, 3));
    delivery.flush().await;
    let mut delivered = Vec::new();
    while let Ok(m) = queue.events.try_recv() {
        delivered.push(m);
    }
    assert_eq!(delivered.len(), 3);
    assert_eq!(
        delivered
            .iter()
            .map(|m| m.id)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        3
    );
}
