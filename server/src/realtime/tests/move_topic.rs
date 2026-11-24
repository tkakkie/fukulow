use super::*;

async fn json_reply(response: Response, status: StatusCode) -> Value {
    let actual = response.status();
    let result: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 256 * 1024).await.unwrap()).unwrap();
    assert_eq!(actual, status, "{result}");
    result
}

async fn channel_get(f: &Fixture, token: &str, tail: &str, status: StatusCode) -> Value {
    json_reply(
        request(
            &f.app,
            "GET",
            &format!("/api/v1/channels/{}{tail}", f.channel),
            token,
            Value::Null,
        )
        .await,
        status,
    )
    .await
}

#[fukulow_test::test]
async fn move_live_gap_and_subscribe_replay_converge_topics_chain_unread_and_mentions(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let (reader, reader_token) = member(&pool, f.organization).await;
    let text = format!("@{{member:{reader}}} body");
    let mut created = Vec::new();
    for (topic, parent) in [
        (Some("Destination"), false),
        (Some("Source"), false),
        (None, true),
    ] {
        let input = json!({
            "client_message_id":Uuid::new_v4(),"body":if topic == Some("Destination") { "earlier" } else { &text },
            "topic_name":topic, "reply_to":if parent { created.get(1).map(|m: &Value| m["id"].clone()) } else { None },
        });
        created.push(
            json_reply(
                request(
                    &f.app,
                    "POST",
                    &format!("/api/v1/channels/{}/messages", f.channel),
                    &f.token,
                    input,
                )
                .await,
                StatusCode::CREATED,
            )
            .await,
        );
    }
    let [dest, root, child] = created.as_slice() else {
        panic!("fixture chain")
    };
    let destination = dest["topic_id"].as_str().unwrap();
    let source = root["topic_id"].as_str().unwrap();
    let anchor = child["id"].as_str().unwrap();
    for (topic, w) in [(source, 1), (destination, 2)] {
        let response = request(
            &f.app,
            "PUT",
            &format!("/api/v1/channels/{}/topics/{topic}/read", f.channel),
            &reader_token,
            json!({"read_seq":w}),
        )
        .await;
        assert_eq!(json_reply(response, StatusCode::OK).await["read_seq"], w);
    }
    let before = channel_get(&f, &reader_token, "/topics", StatusCode::OK).await;
    assert_eq!(before["as_of_seq"], 3);
    assert_eq!(before["topics"][1]["id"], source);
    assert_eq!(before["topics"][1]["unread_count"], 2);
    assert_eq!(before["topics"][1]["mention_unread_count"], 2);
    let counts_before = json_reply(
        request(
            &f.app,
            "GET",
            "/api/v1/channels",
            &reader_token,
            Value::Null,
        )
        .await,
        StatusCode::OK,
    )
    .await;
    assert_eq!(counts_before["channels"][0]["unread_count"], 2);
    assert_eq!(counts_before["channels"][0]["mention_unread_count"], 2);
    f.state.message_delivery.flush().await;

    let mut live = f.server.connect(&reader_token).await;
    subscribe(&mut live, f.channel, 3).await;
    ready(&mut live, f.channel, 3).await;
    let operation = Uuid::new_v4();
    let gate = messages::pause_publication(operation);
    let response = request(&f.app,"POST",&format!("/api/v1/channels/{}/messages/{anchor}/move",f.channel),&f.token,
        json!({"operation_id":operation,"expected_version":3,"topic_id":destination,"history_generation":root["history_generation"]})).await;
    let receipt = json_reply(response, StatusCode::OK).await;
    assert_eq!(receipt["move_seq"], 4);
    gate.entered_within(Duration::from_secs(3)).await;
    let expected = json!({
        "type":"message","kind":"move","history_generation":root["history_generation"],"channel_id":f.channel,
        "seq":4,"version":4,"root_id":root["id"],"source_topic_id":source,"destination_topic_id":destination,
        "operation_id":operation,
    });
    let decoded: ServerEvent = serde_json::from_value(expected.clone()).unwrap();
    assert!(matches!(decoded, ServerEvent::Move(_)));
    assert_eq!(serde_json::to_value(decoded).unwrap(), expected);
    let gap = channel_get(&f, &reader_token, "/events?after_seq=1", StatusCode::OK).await;
    assert_eq!(gap["events"][2], expected);
    for (event, old) in gap["events"].as_array().unwrap()[..2]
        .iter()
        .zip([root, child])
    {
        assert_eq!(event["seq"], old["created_seq"]);
        assert_eq!(event["kind"], "create");
        let mut current = old.clone();
        current["topic_id"] = json!(destination);
        current["version"] = json!(4);
        assert_eq!(event["message"], current);
    }
    assert_eq!(gap["has_more"], false);

    let list = channel_get(&f, &reader_token, "/topics", StatusCode::OK).await;
    assert_eq!(list["as_of_seq"], 4);
    assert_eq!(list["topics"].as_array().unwrap().len(), 1);
    let summary = &list["topics"][0];
    assert_eq!(summary["id"], destination);
    assert_eq!(summary["message_count"], 3);
    assert_eq!(summary["last_seq"], 3);
    assert_eq!(summary["read_seq"], 2);
    assert_eq!(summary["unread_count"], 1);
    assert_eq!(summary["mention_unread_count"], 1);
    assert_eq!(summary["latest_message"], gap["events"][1]["message"]);
    assert_eq!(
        channel_get(&f, &reader_token, "/timeline", StatusCode::OK).await["items"],
        json!([{"kind":"topic","topic":summary}]),
    );
    assert_eq!(
        channel_get(
            &f,
            &reader_token,
            &format!("/topics/{source}"),
            StatusCode::NOT_FOUND
        )
        .await,
        json!({"error":"topic_not_found"}),
    );
    assert_eq!(
        channel_get(
            &f,
            &reader_token,
            &format!("/topics/{source}/messages"),
            StatusCode::OK
        )
        .await["messages"],
        json!([]),
    );
    let chain = channel_get(
        &f,
        &reader_token,
        &format!("/messages/{anchor}/chain"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(chain["chain_version"], 4);
    assert_eq!(
        chain["messages"],
        json!([gap["events"][0]["message"], gap["events"][1]["message"]])
    );
    let counts = json_reply(
        request(
            &f.app,
            "GET",
            "/api/v1/channels",
            &reader_token,
            Value::Null,
        )
        .await,
        StatusCode::OK,
    )
    .await;
    assert_eq!(counts["channels"][0]["as_of_seq"], 4);
    assert_eq!(counts["channels"][0]["read_seq"], 0);
    assert_eq!(counts["channels"][0]["main_unread_count"], 0);
    assert_eq!(counts["channels"][0]["unread_count"], 1);
    assert_eq!(counts["channels"][0]["mention_unread_count"], 1);
    for route in [
        "/messages".into(),
        "/timeline".into(),
        "/topics".into(),
        format!("/topics/{destination}/messages"),
        format!("/messages/{anchor}/chain"),
    ] {
        assert_eq!(
            channel_get(
                &f,
                &reader_token,
                &format!("{route}?as_of_seq=3"),
                StatusCode::CONFLICT
            )
            .await,
            json!({"error":"snapshot_expired"}),
        );
    }
    let stored: (i64, i64) = sqlx::query_as(
        "SELECT t.message_count,p.read_seq FROM topics t JOIN topic_read_positions p \
         ON p.organization_id=t.organization_id AND p.channel_id=t.channel_id AND p.topic_id=t.id \
         WHERE t.organization_id=$1 AND t.channel_id=$2 AND t.id=$3 AND p.member_id=$4",
    )
    .bind(f.organization)
    .bind(f.channel)
    .bind(source.parse::<Uuid>().unwrap())
    .bind(reader)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored, (0, 1));

    // Delay the Move notification and force the next publication to recover it once.
    let next = post(&f, f.channel).await;
    assert_eq!(event(&mut live).await, expected);
    assert_eq!(event(&mut live).await["message"], next);
    gate.release();
    f.state.message_delivery.flush().await;
    silent(&mut live).await;
    let mut replay = f.server.connect(&reader_token).await;
    subscribe(&mut replay, f.channel, 1).await;
    for event_expected in gap["events"].as_array().unwrap() {
        assert_eq!(event(&mut replay).await, *event_expected);
    }
    assert_eq!(event(&mut replay).await["message"], next);
    ready(&mut replay, f.channel, 5).await;

    // Rejoining an emptied Topic revives its original identity and read position.
    let result = json_reply(
        request(
            &f.app,
            "POST",
            &format!("/api/v1/channels/{}/messages/{anchor}/move", f.channel),
            &f.token,
            json!({"operation_id":Uuid::new_v4(),"expected_version":4,"topic_name":"SOURCE"}),
        )
        .await,
        StatusCode::OK,
    )
    .await;
    assert_eq!(result["destination_topic_id"], source);
    let revived = channel_get(
        &f,
        &reader_token,
        &format!("/topics/{source}"),
        StatusCode::OK,
    )
    .await;
    assert_eq!(revived["topic"]["name"], "Source");
    assert_eq!(revived["topic"]["read_seq"], 1);
    assert_eq!(revived["topic"]["last_seq"], 3);
    assert_eq!(revived["topic"]["mention_unread_count"], 2);
}
