use super::*;

#[fukulow_test::test]
async fn reply_counts_stay_exact_and_scoped_after_move(pool: PgPool) {
    let (app, org, author, public, token) = fixture(&pool).await;
    let private = Uuid::new_v4();
    channel(&pool, org, private, author, true).await;
    let reader = Uuid::new_v4();
    let reader_token = member(&pool, org, reader).await;
    grant(&pool, org, private, reader).await;

    let root = sent(
        &app,
        &token,
        private,
        topics::topic_input(Uuid::new_v4(), "Source"),
    )
    .await;
    let child = sent(&app, &token, private, reply_input(Uuid::new_v4(), &root)).await;
    let leaf = sent(&app, &token, private, reply_input(Uuid::new_v4(), &child)).await;
    let destination = sent(
        &app,
        &token,
        private,
        topics::topic_input(Uuid::new_v4(), "Destination"),
    )
    .await;
    let root_id = id(&root);
    let mut ids = [root_id, id(&child), id(&leaf), id(&destination)];
    ids.sort_unstable();
    let expected: Vec<_> = ids
        .iter()
        .map(|&anchor| {
            if anchor == id(&destination) {
                entry(anchor, anchor, 0)
            } else {
                entry(anchor, root_id, 2)
            }
        })
        .collect();
    assert_eq!(
        page(&app, &reader_token, private, &ids).await,
        json!({"as_of_seq":4,"counts":expected})
    );

    let response = request(
        &app,
        "POST",
        &format!("/api/v1/channels/{private}/messages/{}/move", id(&leaf)),
        &token,
        json!({"operation_id":Uuid::new_v4(), "expected_version":3, "topic_id":destination["topic_id"]}),
    ).await;
    assert_eq!(response.status(), StatusCode::OK);
    let receipt = body(response).await;
    assert_eq!(receipt["root_id"], json!(root_id));
    assert_eq!(receipt["destination_topic_id"], destination["topic_id"]);
    assert_eq!(
        page(&app, &reader_token, private, &ids).await,
        json!({"as_of_seq":5,"counts":expected})
    );
    assert_eq!(
        page(&app, &reader_token, public, &ids).await["counts"],
        json!([])
    );

    revoke(&pool, org, private, reader).await;
    error(
        query(&app, &reader_token, private, &ids).await,
        StatusCode::NOT_FOUND,
        "channel not found",
    )
    .await;
    assert_eq!(
        page(&app, &token, private, &ids).await,
        json!({"as_of_seq":5,"counts":expected})
    );
}

#[fukulow_test::test]
async fn reply_counts_exact_chain_totals_deduplicate_and_leave_positions_and_publication_unchanged(
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
        topics::topic_input(Uuid::new_v4(), "Topic"),
    )
    .await;
    let child = sent(&app, &token, channel, reply_input(Uuid::new_v4(), &root)).await;
    let grandchild = sent(&app, &token, channel, reply_input(Uuid::new_v4(), &child)).await;
    let lone = sent(&app, &token, channel, input(Uuid::new_v4(), "Lone")).await;
    sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body,topic_id,reply_to_id,reply_root_id) SELECT $1,$2,gen_random_uuid(),n,$3,gen_random_uuid(),'Reply',$4,$5,$6 FROM generate_series(5,1204) n")
        .bind(org).bind(channel).bind(sender).bind(root["topic_id"].as_str().unwrap().parse::<Uuid>().unwrap()).bind(id(&child)).bind(id(&root)).execute(&pool).await.unwrap();
    sqlx::query(
        "UPDATE channel_message_sequences SET seq=1204 WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(org)
    .bind(channel)
    .execute(&pool)
    .await
    .unwrap();
    delivery.flush().await;
    let mut queue = delivery.queue(org, (sender, 0), 256);
    queue.subscribe(channel);
    let snapshot = || async {
        sqlx::query_scalar::<_,Value>("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(p) ORDER BY channel_id,member_id) FROM channel_read_positions p WHERE organization_id=$1),(SELECT jsonb_agg(to_jsonb(p) ORDER BY channel_id,member_id,topic_id) FROM topic_read_positions p WHERE organization_id=$1),(SELECT count(*) FROM channel_log WHERE organization_id=$1),(SELECT count(*) FROM messages WHERE organization_id=$1),(SELECT sum(seq) FROM channel_message_sequences WHERE organization_id=$1))")
            .bind(org).fetch_one(&pool).await.unwrap()
    };
    let before = snapshot().await;
    let ids = [
        id(&root),
        id(&child),
        id(&grandchild),
        id(&lone),
        id(&child),
    ];
    let result = page(&app, &token, channel, &ids).await;
    let mut expected = vec![
        entry(id(&root), id(&root), 1202),
        entry(id(&child), id(&root), 1202),
        entry(id(&grandchild), id(&root), 1202),
        entry(id(&lone), id(&lone), 0),
    ];
    expected.sort_by_key(|e| e["message_id"].as_str().unwrap().to_owned());
    assert_eq!(result, json!({"as_of_seq":1204,"counts":expected}));
    assert_eq!(
        page(&app, &token, channel, &[id(&root); 100]).await["counts"],
        json!([entry(id(&root), id(&root), 1202)])
    );
    assert_eq!(
        page(
            &app,
            &token,
            channel,
            &(0..100).map(|_| Uuid::new_v4()).collect::<Vec<_>>()
        )
        .await["counts"],
        json!([])
    );
    assert_eq!(snapshot().await, before);
    delivery.flush().await;
    assert!(queue.events.try_recv().is_err());
}

#[fukulow_test::test]
async fn reply_counts_validate_before_organization_channel_and_admission_but_after_session(
    pool: PgPool,
) {
    let (app, org, member, channel, token) = fixture(&pool).await;
    assert_eq!(
        page(&app, &token, channel, &[Uuid::new_v4()]).await,
        json!({"as_of_seq":0,"counts":[]})
    );
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(member)
        .execute(&pool)
        .await
        .unwrap();
    for scope in [org, Uuid::new_v4()] {
        for ch in [channel, Uuid::new_v4()] {
            let path = format!("/api/v1/orgs/{scope}/channels/{ch}/reply-counts");
            for value in [
                json!({"ids":[]}),
                json!({"ids":vec![Uuid::new_v4();101]}),
                json!({"ids":["bad"]}),
                json!({}),
                json!({"ids":[Uuid::new_v4()],"extra":true}),
            ] {
                assert_error(
                    request(&app, "POST", &path, &token, value.clone()).await,
                    StatusCode::BAD_REQUEST,
                )
                .await;
                assert_error(
                    request(&app, "POST", &path, "invalid", value).await,
                    StatusCode::UNAUTHORIZED,
                )
                .await;
            }
            error(
                request(&app, "POST", &path, &token, json!({"ids":[Uuid::new_v4()]})).await,
                StatusCode::NOT_FOUND,
                "organization_unavailable",
            )
            .await;
        }
    }
    for path in [
        format!("/api/v1/orgs/bad/channels/{channel}/reply-counts"),
        format!("/api/v1/orgs/{org}/channels/bad/reply-counts"),
    ] {
        assert_error(
            request(&app, "POST", &path, &token, json!({"ids":[Uuid::new_v4()]})).await,
            StatusCode::BAD_REQUEST,
        )
        .await;
    }
}

#[fukulow_test::test]
async fn reply_counts_unknown_foreign_channel_and_organization_ids_are_omitted_identically(
    pool: PgPool,
) {
    let (app, org, sender, channel, token) = fixture(&pool).await;
    let root = sent(&app, &token, channel, input(Uuid::new_v4(), "Root")).await;
    sent(&app, &token, channel, reply_input(Uuid::new_v4(), &root)).await;
    let other = Uuid::new_v4();
    crate::messages::tests::channel(&pool, org, other, sender, true).await;
    let hidden = sent(&app, &token, other, input(Uuid::new_v4(), "Other Channel")).await;
    let (foreign_app, _, _, foreign, foreign_token) = fixture(&pool).await;
    let foreign = sent(
        &foreign_app,
        &foreign_token,
        foreign,
        input(Uuid::new_v4(), "Foreign Organization"),
    )
    .await;
    let expected = json!({"as_of_seq":2,"counts":[entry(id(&root),id(&root),1)]});
    for unknown in [Uuid::new_v4(), id(&hidden), id(&foreign)] {
        assert_eq!(
            page(&app, &token, channel, &[id(&root), unknown]).await,
            expected
        );
    }
}
