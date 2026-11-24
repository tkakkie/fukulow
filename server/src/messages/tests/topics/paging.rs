use super::*;

fn position(item: &Value) -> i64 {
    if item["kind"] == "topic" {
        item["topic"]["last_seq"].as_i64().unwrap()
    } else {
        item["message"]["created_seq"].as_i64().unwrap()
    }
}

#[fukulow_test::test]
async fn projections_page_newer_at_fixed_w(pool: PgPool) {
    let (app, org, _, channel, token) = fixture(&pool).await;
    for name in [
        Some("A"),
        None,
        Some("B"),
        Some("A"),
        None,
        Some("C"),
        Some("B"),
        Some("C"),
    ] {
        let key = Uuid::new_v4();
        let message = name.map_or_else(|| input(key, "main"), |name| topic_input(key, name));
        sent(&app, &token, channel, message).await;
    }
    let latest = get(&app, &token, channel, "timeline?limit=2").await;
    assert_eq!(latest["as_of_seq"], 8);
    assert_eq!(latest["has_more"], true);

    // A Topic moves beyond W, and new Topics and main Messages stay outside W.
    let later = member(&pool, org, Uuid::new_v4()).await;
    sent(&app, &later, channel, topic_input(Uuid::new_v4(), "A")).await;
    sent(&app, &later, channel, topic_input(Uuid::new_v4(), "D")).await;
    sent(&app, &later, channel, input(Uuid::new_v4(), "later main")).await;

    let mut newer = Vec::new();
    for (after, positions, has_more) in [
        (0, &[2, 4][..], true),
        (4, &[5, 7][..], true),
        (7, &[8][..], false),
        (8, &[][..], false),
        (i64::MAX, &[][..], false),
    ] {
        let page = get(
            &app,
            &token,
            channel,
            &format!("timeline?as_of_seq=8&after_position={after}&limit=2"),
        )
        .await;
        assert_eq!(page["as_of_seq"], 8);
        assert_eq!(page["has_more"], has_more);
        let items = page["items"].as_array().unwrap();
        assert_eq!(items.iter().map(position).collect::<Vec<_>>(), positions);
        newer.extend_from_slice(items);
    }
    let middle = get(
        &app,
        &token,
        channel,
        "timeline?as_of_seq=8&before_position=7&limit=2",
    )
    .await;
    let oldest = get(
        &app,
        &token,
        channel,
        "timeline?as_of_seq=8&before_position=4&limit=2",
    )
    .await;
    let older = [&oldest, &middle, &latest]
        .into_iter()
        .flat_map(|page| page["items"].as_array().unwrap().iter().cloned())
        .collect::<Vec<_>>();
    assert_eq!(newer, older);
    let exact = get(
        &app,
        &token,
        channel,
        "timeline?as_of_seq=8&after_position=5&limit=2",
    )
    .await;
    assert_eq!(
        exact,
        json!({"as_of_seq":8,"items":newer[3..],"has_more":false})
    );

    let topics = newer
        .iter()
        .filter(|item| item["kind"] == "topic")
        .map(|item| item["topic"].clone())
        .collect::<Vec<_>>();
    assert_eq!(
        topics
            .iter()
            .map(|topic| topic["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["A", "B", "C"]
    );
    assert!(topics.iter().all(|topic| topic["message_count"] == 2));
    let first = get(
        &app,
        &token,
        channel,
        "topics?as_of_seq=8&after_position=0&limit=2",
    )
    .await;
    assert_eq!(
        first,
        json!({"as_of_seq":8,"topics":topics[..2],"has_more":true})
    );
    let last = get(
        &app,
        &token,
        channel,
        "topics?as_of_seq=8&after_position=7&limit=2",
    )
    .await;
    assert_eq!(
        last,
        json!({"as_of_seq":8,"topics":topics[2..],"has_more":false})
    );
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
    assert_eq!(baseline["latest_message"]["created_seq"], 4);
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
            .map(|m| m["created_seq"].as_i64().unwrap())
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
async fn topic_pages_exclude_later_topics_and_expire_after_a_move(pool: PgPool) {
    let (app, _, _, channel, token) = fixture(&pool).await;
    let empty = get(&app, &token, channel, "topics?limit=2").await;
    assert_eq!(empty, json!({"as_of_seq":0,"topics":[],"has_more":false}));

    let source = sent(&app, &token, channel, topic_input(Uuid::new_v4(), "A")).await;
    for name in ["B", "C"] {
        sent(&app, &token, channel, topic_input(Uuid::new_v4(), name)).await;
    }
    let first = get(&app, &token, channel, "topics?limit=2").await;
    assert_eq!(first["as_of_seq"], 3);
    assert_eq!(first["has_more"], true);
    assert_eq!(first["topics"][0]["last_seq"], 2);
    assert_eq!(first["topics"][1]["last_seq"], 3);

    for name in ["D", "B", "D"] {
        sent(&app, &token, channel, topic_input(Uuid::new_v4(), name)).await;
    }
    assert_eq!(
        get(&app, &token, channel, "topics?as_of_seq=3&limit=2").await,
        first
    );
    let next = get(
        &app,
        &token,
        channel,
        "topics?as_of_seq=3&before_position=2&limit=2",
    )
    .await;
    assert_eq!(next["has_more"], false);
    assert_eq!(next["topics"].as_array().unwrap().len(), 1);
    assert_eq!(next["topics"][0]["id"], source["topic_id"]);

    let id = source["id"].as_str().unwrap();
    let moved = request(
        &app, "POST", &format!("/api/v1/channels/{channel}/messages/{id}/move"), &token,
        json!({"operation_id":Uuid::new_v4(),"expected_version":source["version"],"topic_name":"D"}),
    ).await;
    assert_eq!(moved.status(), StatusCode::OK);
    for route in ["timeline", "topics"] {
        let expired = request(
            &app,
            "GET",
            &format!("/api/v1/channels/{channel}/{route}?as_of_seq=3"),
            &token,
            Value::Null,
        )
        .await;
        assert_eq!(expired.status(), StatusCode::CONFLICT);
        assert_eq!(body(expired).await, json!({"error":"snapshot_expired"}));
    }
    let fresh = get(&app, &token, channel, "topics?limit=2").await;
    assert_eq!(fresh["as_of_seq"], 7);
    assert_eq!(fresh["topics"][1]["name"], "D");
    assert_eq!(fresh["topics"][1]["first_seq"], 1);
    assert_eq!(fresh["topics"][1]["message_count"], 3);
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
                assert_eq!(topic["latest_message"]["created_seq"], topic["last_seq"]);
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
