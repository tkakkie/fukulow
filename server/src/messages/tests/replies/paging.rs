use super::*;

#[fukulow_test::test]
async fn reply_chain_pages_root_and_all_descendants_from_every_anchor_with_concurrent_appends(
    pool: PgPool,
) {
    let (app, _, _, channel, token) = fixture(&pool).await;
    let root = sent(&app, &token, channel, input(Uuid::new_v4(), "Root")).await;
    let mut tree = vec![root.clone()];
    for parent in [0, 1, 0, 2, 3] {
        sent(&app, &token, channel, input(Uuid::new_v4(), "Unrelated")).await;
        let child = sent(
            &app,
            &token,
            channel,
            reply_input(Uuid::new_v4(), &tree[parent]),
        )
        .await;
        tree.push(child);
    }
    for anchor in &tree {
        assert_eq!(
            page(&app, &token, channel, id(anchor), "").await,
            json!({"root_id":root["id"],"messages":tree,"has_more":false})
        );
        for limit in [1, 2, 3, 5, 6, 200] {
            let mut after = 0;
            let mut seen = Vec::new();
            loop {
                let p = page(
                    &app,
                    &token,
                    channel,
                    id(anchor),
                    &format!("?after_seq={after}&limit={limit}"),
                )
                .await;
                let rows = p["messages"].as_array().unwrap();
                assert!(!rows.is_empty());
                seen.extend(rows.clone());
                assert_eq!(p["has_more"], seen.len() < tree.len());
                after = rows.last().unwrap()["seq"].as_i64().unwrap();
                if !p["has_more"].as_bool().unwrap() {
                    break;
                }
            }
            assert_eq!(seen, tree);
        }
    }
    let mut seen = page(&app, &token, channel, id(&tree[4]), "?limit=2").await["messages"]
        .as_array()
        .unwrap()
        .clone();
    // A new descendant in an unloaded branch arrives while the projection is paged.
    tree.push(sent(&app, &token, channel, reply_input(Uuid::new_v4(), &tree[5])).await);
    while seen.len() < tree.len() {
        let after = seen.last().unwrap()["seq"].as_i64().unwrap();
        let p = page(
            &app,
            &token,
            channel,
            id(&tree[4]),
            &format!("?after_seq={after}&limit=2"),
        )
        .await;
        seen.extend(p["messages"].as_array().unwrap().clone());
        assert_eq!(p["has_more"], seen.len() < tree.len());
    }
    assert_eq!(seen, tree);
    let after = tree.last().unwrap()["seq"].as_i64().unwrap();
    for boundary in [after, i64::MAX] {
        assert_eq!(
            page(
                &app,
                &token,
                channel,
                id(&root),
                &format!("?after_seq={boundary}")
            )
            .await,
            json!({"root_id":root["id"],"messages":[],"has_more":false})
        );
    }
    let lone = sent(&app, &token, channel, input(Uuid::new_v4(), "Lone root")).await;
    assert_eq!(
        page(&app, &token, channel, id(&lone), "?limit=1").await,
        json!({"root_id":lone["id"],"messages":[lone],"has_more":false})
    );
}

#[fukulow_test::test]
async fn reply_chain_validates_before_channel_authorization_and_defaults_to_50_max_200(
    pool: PgPool,
) {
    let (app, org, sender, channel, token) = fixture(&pool).await;
    let root = sent(&app, &token, channel, input(Uuid::new_v4(), "Root")).await;
    sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body,reply_to_id,reply_root_id) SELECT $1,$2,gen_random_uuid(),n,$3,gen_random_uuid(),'Reply',$4,$4 FROM generate_series(2,202) n")
        .bind(org).bind(channel).bind(sender).bind(id(&root)).execute(&pool).await.unwrap();
    sqlx::query(
        "UPDATE channel_message_sequences SET seq=202 WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(org)
    .bind(channel)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        page(&app, &token, channel, id(&root), "").await["messages"]
            .as_array()
            .unwrap()
            .len(),
        50
    );
    let p = page(&app, &token, channel, id(&root), "?limit=200").await;
    assert_eq!(p["messages"].as_array().unwrap().len(), 200);
    assert_eq!(p["has_more"], true);
    let end = page(&app, &token, channel, id(&root), "?after_seq=200&limit=200").await;
    assert_eq!(end["messages"].as_array().unwrap().len(), 2);
    assert_eq!(end["has_more"], false);
    for q in [
        "?after_seq=-1",
        "?after_seq=no",
        "?after_seq=9223372036854775808",
        "?limit=0",
        "?limit=201",
        "?limit=-1",
        "?limit=no",
        "?limit=65536",
    ] {
        for ch in [channel, Uuid::new_v4()] {
            assert_error(
                chain(&app, &token, ch, id(&root), q).await,
                StatusCode::BAD_REQUEST,
            )
            .await;
        }
    }
}

#[fukulow_test::test]
async fn reply_chain_watermark_saturation_preserves_denial_precedence_and_retry_after(
    pool: PgPool,
) {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let (_, org, owner, channel, token) = fixture(&pool).await;
    let state = AppState::for_test(pool.clone()).await;
    let delivery = state.message_delivery.clone();
    let app = crate::app(state);
    let private = Uuid::new_v4();
    super::super::channel(&pool, org, private, owner, true).await;
    let root = sent(&app, &token, private, input(Uuid::new_v4(), "Root")).await;
    let viewer = member(&pool, org, Uuid::new_v4()).await;
    let mut permits = Vec::new();
    for _ in 0..4 {
        permits.push(
            delivery
                .admission(&pool)
                .acquire(org, private, false)
                .await
                .unwrap(),
        );
    }
    error(
        chain(&app, &viewer, private, id(&root), "").await,
        StatusCode::NOT_FOUND,
        "channel not found",
    )
    .await;
    let response = chain(&app, &token, private, id(&root), "").await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        (1..=5).contains(
            &response.headers()[header::RETRY_AFTER]
                .to_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
        )
    );
    error(
        response,
        StatusCode::SERVICE_UNAVAILABLE,
        "projection admission unavailable",
    )
    .await;
    drop(permits);
    assert_eq!(
        page(&app, &token, private, id(&root), "").await["messages"],
        json!([root])
    );
    assert_eq!(counts(&pool, org, channel).await, (0, 0, 0));
}
