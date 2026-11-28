use super::*;

fn assert_removal_denied(error: sqlx::Error, operation: &str) {
    let error = error.as_database_error().unwrap();
    assert_eq!(error.code().as_deref(), Some("P0001"));
    assert_eq!(
        error.message(),
        format!("Message rows must never be removed with {operation}")
    );
}

#[fukulow_test::test]
async fn message_owner_delete_is_denied(owner: PgPool) {
    let (app, org, _, channel, token) = fixture(&owner).await;
    sent(&app, &token, channel, input(Uuid::new_v4(), "retained")).await;
    let error = sqlx::query("DELETE FROM messages WHERE organization_id = $1 AND channel_id = $2")
        .bind(org)
        .bind(channel)
        .execute(&owner)
        .await
        .unwrap_err();
    assert_removal_denied(error, "DELETE");
}

#[fukulow_test::test]
async fn message_owner_truncate_is_denied(owner: PgPool) {
    let error = sqlx::query("TRUNCATE messages, message_mentions, message_search_terms")
        .execute(&owner)
        .await
        .unwrap_err();
    assert_removal_denied(error, "TRUNCATE");
}

#[fukulow_test::test]
async fn message_owner_parent_truncate_cascade_is_denied(owner: PgPool) {
    let error = sqlx::query("TRUNCATE channels CASCADE")
        .execute(&owner)
        .await
        .unwrap_err();
    assert_removal_denied(error, "TRUNCATE");
}

#[fukulow_test::test]
async fn message_owner_parent_delete_cascade_is_denied(owner: PgPool) {
    let (app, org, _, channel, token) = fixture(&owner).await;
    sent(
        &app,
        &token,
        channel,
        json!({"client_message_id": Uuid::new_v4(), "body": "retained", "topic_name": "Topic"}),
    )
    .await;

    // Exercise PostgreSQL's cascade with a test-only variant of the NO ACTION FK.
    let mut tx = owner.begin().await.unwrap();
    sqlx::raw_sql(
        "ALTER TABLE messages DROP CONSTRAINT messages_topic_channel_fk,
         ADD CONSTRAINT messages_topic_channel_fk
         FOREIGN KEY (organization_id, channel_id, topic_id)
         REFERENCES topics (organization_id, channel_id, id) ON DELETE CASCADE",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("DELETE FROM topic_read_positions WHERE organization_id = $1 AND channel_id = $2")
        .bind(org)
        .bind(channel)
        .execute(&mut *tx)
        .await
        .unwrap();
    let error = sqlx::query("DELETE FROM topics WHERE organization_id = $1 AND channel_id = $2")
        .bind(org)
        .bind(channel)
        .execute(&mut *tx)
        .await
        .unwrap_err();
    assert_removal_denied(error, "DELETE");
    tx.rollback().await.unwrap();
}

#[fukulow_test::test]
async fn message_tombstone_preserves_replay_and_corrects_unread_counts(pool: PgPool) {
    let (app, org, _, channel, token) = fixture(&pool).await;
    let viewer = Uuid::new_v4();
    let viewer_token = member(&pool, org, viewer).await;
    let message = sent(
        &app,
        &token,
        channel,
        input(Uuid::new_v4(), &format!("@{{member:{viewer}}}")),
    )
    .await;
    sent(&app, &token, channel, input(Uuid::new_v4(), "still unread")).await;
    let counts = async || {
        let response = request(&app, "GET", "/api/v1/channels", &viewer_token, Value::Null).await;
        assert_eq!(response.status(), StatusCode::OK);
        let result = body(response).await;
        let channel = &result["channels"][0];
        (
            channel["unread_count"].as_i64().unwrap(),
            channel["mention_unread_count"].as_i64().unwrap(),
        )
    };
    assert_eq!(counts().await, (2, 1));

    let id: Uuid = message["id"].as_str().unwrap().parse().unwrap();
    let restricted = crate::test_app_pool(pool).await;
    // Stage 1 has no Delete endpoint. Commit the tombstone through the runtime role.
    let updated = crate::database::organization(&restricted, org, async |tx| {
        sqlx::query(
            "UPDATE messages SET body = '', deleted = true WHERE organization_id = $1 AND id = $2",
        )
        .bind(org)
        .bind(id)
        .execute(tx)
        .await
    })
    .await
    .unwrap();
    assert_eq!(updated.rows_affected(), 1);
    assert_eq!(counts().await, (1, 0));

    let page = super::super::log::replay_page(&restricted, org, channel, 0, 2)
        .await
        .unwrap();
    assert_eq!(page.len(), 2);
    assert_eq!(page[0].seq, 1);
    assert!(page[0].message().deleted);
    assert!(page[0].message().body.is_none());
    assert_eq!(page[1].seq, 2);
    assert_eq!(page[1].message().body.as_deref(), Some("still unread"));
}
