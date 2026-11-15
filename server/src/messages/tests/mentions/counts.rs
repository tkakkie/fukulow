use super::*;

async fn mark(app: &Router, author: &str, channel: Uuid, scope: Option<&str>, seq: i64) {
    let suffix = scope.map_or_else(|| "read".into(), |id| format!("topics/{id}/read"));
    let response = request(
        app,
        "PUT",
        &format!("/api/v1/channels/{channel}/{suffix}"),
        author,
        json!({"read_seq":seq}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
}

#[fukulow_test::test]
async fn mention_counts_dedup_own_independent_positions_marks_and_no_backfill(pool: PgPool) {
    let (app, org, _, channel, author) = fixture(&pool).await;
    let reader = Uuid::new_v4();
    let viewer = member(&pool, org, reader).await;
    let text = format!("{}{}", token(reader), token(reader));
    let root = sent(&app, &author, channel, input(Uuid::new_v4(), &text)).await;
    sent(
        &app,
        &author,
        channel,
        json!({"client_message_id":Uuid::new_v4(),"body":text,"reply_to":root["id"]}),
    )
    .await;
    let topic = sent(
        &app,
        &author,
        channel,
        json!({"client_message_id":Uuid::new_v4(),"body":text,"topic_name":"Hidden"}),
    )
    .await;
    let t = topic["topic_id"].as_str().unwrap();
    let w = topic["seq"].as_i64().unwrap();
    sent(
        &app,
        &author,
        channel,
        json!({"client_message_id":Uuid::new_v4(),"body":text,"reply_to":topic["id"]}),
    )
    .await;
    sent(&app, &viewer, channel, input(Uuid::new_v4(), &text)).await;
    sent(
        &app,
        &viewer,
        channel,
        json!({"client_message_id":Uuid::new_v4(),"body":text,"topic_name":"Hidden"}),
    )
    .await;
    let c = counts(&app, &viewer).await;
    assert_eq!(c["channels"][0]["main_mention_unread_count"], 2);
    assert_eq!(c["channels"][0]["mention_unread_count"], 4);
    assert_eq!(c["channels"][0]["unread_count"], 4);
    let summary = projection(&app, &viewer, channel, &format!("topics/{t}")).await;
    assert_eq!(summary["topic"]["mention_unread_count"], 2);
    let prefix = projection(&app, &viewer, channel, &format!("topics?as_of_seq={w}")).await;
    assert_eq!(prefix["topics"][0]["mention_unread_count"], 1);
    projection(
        &app,
        &viewer,
        channel,
        &format!("messages/{}/chain", topic["id"].as_str().unwrap()),
    )
    .await;
    assert_eq!(counts(&app, &viewer).await, c);
    mark(&app, &viewer, channel, None, i64::MAX).await;
    let c = counts(&app, &viewer).await;
    assert_eq!(c["channels"][0]["main_mention_unread_count"], 0);
    assert_eq!(c["channels"][0]["mention_unread_count"], 2);
    assert_eq!(
        projection(&app, &viewer, channel, &format!("topics/{t}")).await,
        summary
    );
    mark(&app, &viewer, channel, Some(t), w).await;
    assert_eq!(
        counts(&app, &viewer).await["channels"][0]["mention_unread_count"],
        1
    );
    mark(&app, &viewer, channel, Some(t), i64::MAX).await;
    mark(&app, &viewer, channel, Some(t), 0).await;
    let fresh = router(&pool).await;
    let c = counts(&fresh, &viewer).await;
    assert_eq!(c["channels"][0]["mention_unread_count"], 0);
    assert_eq!(c["channels"][0]["unread_count"], 0);
    // Simulate a pre-Mention Message carrying the exact historical token.
    let historical = sent(
        &app,
        &author,
        channel,
        json!({"client_message_id":Uuid::new_v4(),"body":text,"topic_name":"New"}),
    )
    .await;
    sqlx::query("DELETE FROM message_mentions WHERE organization_id=$1 AND message_id=$2")
        .bind(org)
        .bind(Uuid::parse_str(historical["id"].as_str().unwrap()).unwrap())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        counts(&app, &viewer).await["channels"][0]["mention_unread_count"],
        0
    );
    let history = list(&app, &viewer, channel, "").await;
    assert_eq!(
        history["messages"].as_array().unwrap().last().unwrap()["mentions"],
        json!([])
    );
    let topics = projection(&app, &viewer, channel, "topics").await;
    assert_eq!(
        topics["topics"].as_array().unwrap().last().unwrap()["mention_unread_count"],
        0
    );
}

#[fukulow_test::test]
async fn mention_counts_missing_position_suppresses_only_its_channel_without_writes(pool: PgPool) {
    let (app, org, sender, channel, author) = fixture(&pool).await;
    let reader = Uuid::new_v4();
    let viewer = member(&pool, org, reader).await;
    let other = Uuid::new_v4();
    super::super::channel(&pool, org, other, sender, false).await;
    for c in [channel, other] {
        sent(&app, &author, c, input(Uuid::new_v4(), &token(reader))).await;
        sent(
            &app,
            &author,
            c,
            json!({"client_message_id":Uuid::new_v4(),"body":token(reader),"topic_name":"Topic"}),
        )
        .await;
    }
    sqlx::query("DELETE FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(org).bind(channel).bind(reader).execute(&pool).await.unwrap();
    let c = counts(&app, &viewer).await;
    for item in c["channels"].as_array().unwrap() {
        let affected = item["id"] == channel.to_string();
        assert_eq!(item["mention_unread_count"], if affected { 0 } else { 2 });
        assert_eq!(
            item["main_mention_unread_count"],
            if affected { 0 } else { 1 }
        );
    }
    let topics = projection(&app, &viewer, channel, "topics").await;
    assert_eq!(topics["topics"][0]["read_seq"], topics["as_of_seq"]);
    assert_eq!(topics["topics"][0]["mention_unread_count"], 0);
    assert_eq!(
        request(
            &app,
            "PUT",
            &format!("/api/v1/channels/{channel}/read"),
            &viewer,
            json!({"read_seq":2})
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let positions:i64=sqlx::query_scalar("SELECT count(*) FROM channel_read_positions WHERE organization_id=$1 AND member_id=$2 AND channel_id=$3").bind(org).bind(reader).bind(channel).fetch_one(&pool).await.unwrap();
    assert_eq!(positions, 0);
    // A corrupt old revision is equivalent to a missing current position, even
    // when an explicit Topic position survived beside it.
    sqlx::query("INSERT INTO channel_read_positions (organization_id,channel_id,member_id,membership_revision,initial_seq,read_seq) VALUES ($1,$2,$3,99,0,0)")
        .bind(org).bind(channel).bind(reader).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO topic_read_positions SELECT organization_id,channel_id,$3,id,0 FROM topics WHERE organization_id=$1 AND channel_id=$2")
        .bind(org).bind(channel).bind(reader).execute(&pool).await.unwrap();
    let topics = projection(&app, &viewer, channel, "topics").await;
    assert_eq!(topics["topics"][0]["read_seq"], topics["as_of_seq"]);
    assert_eq!(topics["topics"][0]["mention_unread_count"], 0);
    let c = counts(&app, &viewer).await;
    assert_eq!(
        c["channels"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == channel.to_string())
            .unwrap()["mention_unread_count"],
        0
    );
}

#[fukulow_test::test]
async fn mention_access_loss_removes_counts_and_regrant_never_resurrects_them(pool: PgPool) {
    let (app, org, sender, channel, author) = fixture(&pool).await;
    let reader = Uuid::new_v4();
    let viewer = member(&pool, org, reader).await;
    grant(&pool, org, channel, sender).await;
    grant(&pool, org, channel, reader).await;
    sqlx::query("UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(channel)
        .execute(&pool)
        .await
        .unwrap();
    let other = Uuid::new_v4();
    super::super::channel(&pool, org, other, sender, false).await;
    sent(&app, &author, other, input(Uuid::new_v4(), &token(reader))).await;
    let root = sent(
        &app,
        &author,
        channel,
        input(Uuid::new_v4(), &token(reader)),
    )
    .await;
    let topic = sent(
        &app,
        &author,
        channel,
        json!({"client_message_id":Uuid::new_v4(),"body":token(reader),"topic_name":"Hidden"}),
    )
    .await;
    assert_eq!(
        counts(&app, &viewer).await["channels"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == channel.to_string())
            .unwrap()["mention_unread_count"],
        2
    );
    sqlx::query(
        "DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3",
    )
    .bind(org)
    .bind(channel)
    .bind(reader)
    .execute(&pool)
    .await
    .unwrap();
    let remaining = counts(&app, &viewer).await;
    assert_eq!(remaining["channels"].as_array().unwrap().len(), 1);
    assert_eq!(remaining["channels"][0]["id"], other.to_string());
    assert_eq!(remaining["channels"][0]["mention_unread_count"], 1);
    for suffix in [
        "messages".into(),
        "timeline".into(),
        "topics".into(),
        format!("topics/{}", topic["topic_id"].as_str().unwrap()),
        format!("topics/{}/messages", topic["topic_id"].as_str().unwrap()),
        format!("messages/{}/chain", root["id"].as_str().unwrap()),
    ] {
        let response = request(
            &app,
            "GET",
            &format!("/api/v1/channels/{channel}/{suffix}"),
            &viewer,
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(body(response).await, json!({"error":"channel not found"}));
    }
    let app_pool = crate::test_app_pool(pool.clone()).await;
    assert!(matches!(
        authorized_replay_page(&app_pool, org, (reader, 0), channel, 0, 2).await,
        Err(MessageError::NotFound)
    ));
    assert_eq!(
        authorized_replay_page(&app_pool, org, (reader, 0), other, 0, 1)
            .await
            .unwrap()[0]
            .mentions
            .len(),
        1
    );
    grant(&pool, org, channel, reader).await;
    let c = counts(&app, &viewer).await;
    assert_eq!(
        c["channels"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == channel.to_string())
            .unwrap()["mention_unread_count"],
        0
    );
    assert_eq!(
        projection(&app, &viewer, channel, "topics").await["topics"][0]["mention_unread_count"],
        0
    );
    // Retained acceptance remains visible to an authorized reader and target.
    assert_eq!(
        list(&app, &viewer, channel, "").await["messages"][0]["mentions"],
        root["mentions"]
    );
    let later = sent(
        &app,
        &author,
        channel,
        input(Uuid::new_v4(), &token(reader)),
    )
    .await;
    assert_eq!(later["mentions"], root["mentions"]);
    assert_eq!(
        counts(&app, &viewer).await["channels"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == channel.to_string())
            .unwrap()["mention_unread_count"],
        1
    );
}
