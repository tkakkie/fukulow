use super::*;

fn position(item: &Value) -> i64 {
    if item["kind"] == "topic" {
        item["topic"]["last_seq"].as_i64().unwrap()
    } else {
        item["message"]["seq"].as_i64().unwrap()
    }
}

#[fukulow_test::test]
async fn topic_projection_paging_preserves_w_counts_positions_and_unfiltered_holes(pool: PgPool) {
    let (app, _, _, channel, token) = fixture(&pool).await;
    let a = sent(&app, &token, channel, topic_input(Uuid::new_v4(), "A")).await;
    let plain = sent(&app, &token, channel, input(Uuid::new_v4(), "plain")).await;
    let b = sent(&app, &token, channel, topic_input(Uuid::new_v4(), "B")).await;
    sent(&app, &token, channel, topic_input(Uuid::new_v4(), "A")).await;
    let c = sent(&app, &token, channel, topic_input(Uuid::new_v4(), "C")).await;
    sent(&app, &token, channel, topic_input(Uuid::new_v4(), "B")).await;
    let first = get(&app, &token, channel, "timeline?limit=2").await;
    assert_eq!(first["as_of_seq"], 6);
    assert_eq!(first["has_more"], true);
    assert_eq!(
        first["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(position)
            .collect::<Vec<_>>(),
        vec![5, 6]
    );
    assert_eq!(first["items"][0]["topic"]["id"], c["topic_id"]);
    assert_eq!(first["items"][1]["topic"]["id"], b["topic_id"]);
    assert_eq!(first["items"][1]["topic"]["message_count"], 2);
    for name in ["A", "C", "D"] {
        sent(&app, &token, channel, topic_input(Uuid::new_v4(), name)).await;
    }
    sent(&app, &token, channel, input(Uuid::new_v4(), "later plain")).await;
    let older = get(
        &app,
        &token,
        channel,
        "timeline?as_of_seq=6&before_position=5&limit=2",
    )
    .await;
    assert_eq!(older["has_more"], false);
    assert_eq!(
        older["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(position)
            .collect::<Vec<_>>(),
        vec![2, 4]
    );
    assert_eq!(
        older["items"][0],
        json!({"kind":"message", "message":plain})
    );
    let baseline = &older["items"][1]["topic"];
    assert_eq!(baseline["id"], a["topic_id"]);
    assert_eq!(baseline["first_seq"], 1);
    assert_eq!(baseline["last_seq"], 4);
    assert_eq!(baseline["message_count"], 2);
    assert_eq!(baseline["latest_message"]["seq"], 4);
    assert_eq!(
        get(&app, &token, channel, "timeline?as_of_seq=6&limit=2").await,
        first
    );
    let topics = get(&app, &token, channel, "topics?as_of_seq=6&limit=2").await;
    assert_eq!(topics["topics"][0]["last_seq"], 5);
    assert_eq!(topics["topics"][1]["last_seq"], 6);
    let topics = get(
        &app,
        &token,
        channel,
        "topics?as_of_seq=6&before_position=5&limit=2",
    )
    .await;
    assert_eq!(topics["topics"], json!([baseline]));
    assert_eq!(topics["has_more"], false);
    let current = get(
        &app,
        &token,
        channel,
        &format!("topics/{}", a["topic_id"].as_str().unwrap()),
    )
    .await;
    assert_eq!(current["as_of_seq"], 10);
    assert_eq!(current["topic"]["last_seq"], 7);
    assert_eq!(current["topic"]["message_count"], 3);
    // Projection holes are real: the stream/gap-fill route still contains all seq.
    let unfiltered = list(&app, &token, channel, "?after_seq=0").await;
    assert_eq!(
        unfiltered["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["seq"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        (1..=10).collect::<Vec<_>>()
    );
    let prefix = get(&app, &token, channel, "timeline?as_of_seq=3").await;
    assert_eq!(prefix["items"][0]["topic"]["message_count"], 1);
    assert_eq!(prefix["items"][0]["topic"]["last_seq"], 1);
}

#[fukulow_test::test]
async fn topic_history_is_bounded_exclusive_ascending_and_projection_queries_validate(
    pool: PgPool,
) {
    let (app, _, _, channel, token) = fixture(&pool).await;
    let mut messages = Vec::new();
    for _ in 0..4 {
        messages.push(sent(&app, &token, channel, topic_input(Uuid::new_v4(), "Topic")).await);
        sent(
            &app,
            &token,
            channel,
            input(Uuid::new_v4(), "hidden from Topic"),
        )
        .await;
    }
    let id = messages[0]["topic_id"].as_str().unwrap();
    let base = format!("topics/{id}/messages");
    let latest = get(&app, &token, channel, &format!("{base}?limit=2")).await;
    assert_eq!(latest, json!({"messages": messages[2..], "has_more":true}));
    assert_eq!(
        get(
            &app,
            &token,
            channel,
            &format!("{base}?before_seq=5&limit=2")
        )
        .await,
        json!({"messages":messages[..2],"has_more":false})
    );
    assert_eq!(
        get(
            &app,
            &token,
            channel,
            &format!("{base}?after_seq=1&limit=2")
        )
        .await,
        json!({"messages":messages[1..3],"has_more":true})
    );
    assert_eq!(
        get(&app, &token, channel, &format!("{base}?after_seq=5")).await,
        json!({"messages":messages[3..],"has_more":false})
    );
    for route in ["timeline", "topics"] {
        for query in [
            "before_position=1",
            "as_of_seq=-1",
            "as_of_seq=9",
            "as_of_seq=8&before_position=0",
            "limit=0",
            "limit=201",
            "as_of_seq=x",
        ] {
            assert_error(
                request(
                    &app,
                    "GET",
                    &format!("/api/v1/channels/{channel}/{route}?{query}"),
                    &token,
                    Value::Null,
                )
                .await,
                StatusCode::BAD_REQUEST,
            )
            .await;
        }
        let empty = get(&app, &token, channel, &format!("{route}?as_of_seq=0")).await;
        assert_eq!(empty["as_of_seq"], 0);
        assert_eq!(empty["has_more"], false);
    }
    for query in [
        "after_seq=0&before_seq=2",
        "after_seq=-1",
        "before_seq=0",
        "limit=201",
    ] {
        assert_error(
            request(
                &app,
                "GET",
                &format!("/api/v1/channels/{channel}/{base}?{query}"),
                &token,
                Value::Null,
            )
            .await,
            StatusCode::BAD_REQUEST,
        )
        .await;
    }
}

#[fukulow_test::test]
async fn topic_paging_many_moved_topics_has_no_loss_or_duplication(pool: PgPool) {
    let (app, _, _, channel, token) = fixture(&pool).await;
    let mut expected = std::collections::BTreeSet::new();
    for n in 0..40 {
        let m = sent(
            &app,
            &token,
            channel,
            topic_input(Uuid::new_v4(), &format!("Topic {n}")),
        )
        .await;
        expected.insert(m["topic_id"].as_str().unwrap().to_owned());
    }
    let first = get(&app, &token, channel, "timeline?limit=7").await;
    assert_eq!(first["as_of_seq"], 40);
    // All current last_seq values are now beyond every old continuation boundary.
    for n in 0..40 {
        sent(
            &app,
            &token,
            channel,
            topic_input(Uuid::new_v4(), &format!("Topic {n}")),
        )
        .await;
    }
    sent(
        &app,
        &token,
        channel,
        topic_input(Uuid::new_v4(), "New after W"),
    )
    .await;
    for route in ["timeline", "topics"] {
        let mut page = if route == "timeline" {
            first.clone()
        } else {
            get(&app, &token, channel, "topics?as_of_seq=40&limit=7").await
        };
        let mut ids = std::collections::BTreeSet::new();
        loop {
            assert_eq!(page["as_of_seq"], 40);
            let summaries = if route == "timeline" {
                page["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|i| &i["topic"])
                    .collect::<Vec<_>>()
            } else {
                page["topics"].as_array().unwrap().iter().collect()
            };
            for topic in &summaries {
                assert!(
                    ids.insert(topic["id"].as_str().unwrap().to_owned()),
                    "no duplicate Topic"
                );
                assert_eq!(topic["message_count"], 1);
                assert_eq!(topic["first_seq"], topic["last_seq"]);
                assert_eq!(topic["latest_message"]["seq"], topic["last_seq"]);
                assert!(topic["last_seq"].as_i64().unwrap() <= 40);
            }
            if page["has_more"] == false {
                break;
            }
            let boundary = summaries[0]["last_seq"].as_i64().unwrap();
            page = get(
                &app,
                &token,
                channel,
                &format!("{route}?as_of_seq=40&before_position={boundary}&limit=7"),
            )
            .await;
        }
        assert_eq!(
            ids, expected,
            "no omitted Topic after all current positions move past W"
        );
    }
}
