use super::*;

#[fukulow_test::test]
async fn reply_waiting_on_move_rereads_parent_and_inherits_destination(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let root = f.root().await;
    let operation = named(1, "Destination");
    let gate = pause_commit(operation["operation_id"].as_str().unwrap().parse().unwrap());
    let move_task = {
        let (app, token, channel, root) = (f.app.clone(), f.token.clone(), f.channel, id(&root));
        tokio::spawn(async move { move_request(&app, &token, channel, root, operation).await })
    };
    gate.entered_within(Duration::from_secs(3)).await;
    // Independent admission lets the Reply read the old committed parent while
    // Move holds the database writer barrier.
    let reply_app = router(&pool).await;
    let key = Uuid::new_v4();
    let parent = history::pause_reply_parent(key);
    let reply_task = {
        let (token, channel) = (f.token.clone(), f.channel);
        tokio::spawn(async move { sent(&reply_app, &token, channel, reply(key, &root)).await })
    };
    parent.entered_within(Duration::from_secs(3)).await;
    parent.release();
    gate.release.add_permits(1);
    let outcome = moved(move_task.await.unwrap()).await;
    let reply = reply_task.await.unwrap();
    assert_eq!(outcome.move_seq, Some(2));
    assert_eq!(reply["topic_id"], json!(outcome.destination_topic_id));
    assert_eq!(reply["reply_root_id"], json!(outcome.root_id));
    assert_eq!(reply["version"], 3);
}

#[fukulow_test::test]
async fn move_waiting_on_reply_includes_committed_reply(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let root = f.root().await;
    let key = Uuid::new_v4();
    let gate = pause_commit(key);
    let reply_task = {
        let (app, token, channel, input) =
            (f.app.clone(), f.token.clone(), f.channel, reply(key, &root));
        tokio::spawn(async move { sent(&app, &token, channel, input).await })
    };
    gate.entered_within(Duration::from_secs(3)).await;
    let move_app = router(&pool).await;
    let task = {
        let (token, channel, anchor) = (f.token.clone(), f.channel, id(&root));
        tokio::spawn(async move {
            move_request(&move_app, &token, channel, anchor, named(2, "Destination")).await
        })
    };
    wait_for_lock(&pool, "%pg_advisory_xact_lock(hashtextextended%135)%").await;
    gate.release.add_permits(1);
    let reply = reply_task.await.unwrap();
    assert!(reply["topic_id"].is_null());
    let result = moved(task.await.unwrap()).await;
    assert_eq!(result.move_seq, Some(3));
    let chain = body(
        request(
            &f.app,
            "GET",
            &format!(
                "/api/v1/channels/{}/messages/{}/chain",
                f.channel,
                id(&reply)
            ),
            &f.token,
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(chain["chain_version"], 3);
    assert_eq!(chain["messages"][1]["id"], reply["id"]);
    assert_eq!(
        chain["messages"][1]["topic_id"],
        json!(result.destination_topic_id)
    );
    assert_eq!(chain["messages"][1]["version"], 3);
}

#[fukulow_test::test]
async fn move_ambiguous_commit_recovers_by_same_key_without_reallocating(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let root = f.root().await;
    let intent = named(1, "Target");
    let pending = ambiguous_commit(intent["operation_id"].as_str().unwrap().parse().unwrap());
    let response = move_request(&f.app, &f.token, f.channel, id(&root), intent.clone()).await;
    assert_error(response, StatusCode::INTERNAL_SERVER_ERROR).await;
    let tx = pending.await.unwrap();
    let before = state(&pool, f.org, f.channel).await;
    assert!(before[4].is_null());
    tx.commit().await.unwrap();
    assert_eq!(
        moved(move_request(&f.app, &f.token, f.channel, id(&root), intent).await)
            .await
            .move_seq,
        Some(2)
    );
    let after = state(&pool, f.org, f.channel).await;
    assert_eq!(after[3].as_array().unwrap().len(), 2);
    assert_eq!(after[4].as_array().unwrap().len(), 1);
}

pub(super) async fn wait_for_lock(pool: &PgPool, query: &str) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
                 AND wait_event_type='Lock' AND query LIKE $1)",
            )
            .bind(query)
            .fetch_one(pool)
            .await
            .unwrap();
            if waiting {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[fukulow_test::test]
async fn move_holds_manager_grant_until_commit_and_rechecks_before_retry(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let private = Uuid::new_v4();
    channel(&pool, f.org, private, f.sender, true).await;
    let manager = Uuid::new_v4();
    let token = member(&pool, f.org, manager).await;
    sqlx::query("INSERT INTO channel_members(organization_id,channel_id,member_id,manager) VALUES($1,$2,$3,true)")
        .bind(f.org).bind(private).bind(manager).execute(&pool).await.unwrap();
    let root = sent(&f.app, &f.token, private, input(Uuid::new_v4(), "private")).await;
    let intent = named(1, "Target");
    let gate = pause_commit(intent["operation_id"].as_str().unwrap().parse().unwrap());
    let task = {
        let (app, token, anchor, intent) =
            (f.app.clone(), token.clone(), id(&root), intent.clone());
        tokio::spawn(async move { move_request(&app, &token, private, anchor, intent).await })
    };
    gate.entered_within(Duration::from_secs(3)).await;
    let revoke = {
        let (pool, org) = (pool.clone(), f.org);
        tokio::spawn(async move {
            sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                .bind(org).bind(private).bind(manager).execute(&pool).await.unwrap()
        })
    };
    wait_for_lock(&pool, "DELETE FROM channel_members%").await;
    gate.release.add_permits(1);
    assert_eq!(moved(task.await.unwrap()).await.move_seq, Some(2));
    assert_eq!(revoke.await.unwrap().rows_affected(), 1);
    let before = state(&pool, f.org, private).await;
    error(
        move_request(&f.app, &token, private, id(&root), intent).await,
        StatusCode::NOT_FOUND,
        "channel not found",
    )
    .await;
    assert_eq!(state(&pool, f.org, private).await, before);
}

#[fukulow_test::test]
async fn concurrent_move_operation_key_across_channels_leaves_loser_unchanged(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let another = Uuid::new_v4();
    channel(&pool, f.org, another, f.sender, false).await;
    let first = f.root().await;
    let second = sent(&f.app, &f.token, another, input(Uuid::new_v4(), "Second")).await;
    let before = state(&pool, f.org, another).await;
    let input = named(1, "Target");
    let gate = pause_commit(input["operation_id"].as_str().unwrap().parse().unwrap());
    let winner = {
        let (app, token, channel, anchor, input) = (
            f.app.clone(),
            f.token.clone(),
            f.channel,
            id(&first),
            input.clone(),
        );
        tokio::spawn(async move { move_request(&app, &token, channel, anchor, input).await })
    };
    gate.entered_within(Duration::from_secs(3)).await;
    let loser = {
        let (app, token, anchor) = (f.app.clone(), f.token.clone(), id(&second));
        tokio::spawn(async move { move_request(&app, &token, another, anchor, input).await })
    };
    wait_for_lock(&pool, "INSERT INTO operation_receipts%").await;
    let untouched_counter: i64 = sqlx::query_scalar(
        "SELECT seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2 FOR UPDATE NOWAIT",
    )
    .bind(f.org)
    .bind(another)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(untouched_counter, 1);
    gate.release.add_permits(1);
    assert_eq!(moved(winner.await.unwrap()).await.move_seq, Some(2));
    error(
        loser.await.unwrap(),
        StatusCode::CONFLICT,
        "operation_conflict",
    )
    .await;
    assert_eq!(state(&pool, f.org, another).await, before);
    assert_eq!(
        moved(move_request(&f.app, &f.token, another, id(&second), named(1, "Target")).await)
            .await
            .move_seq,
        Some(2),
    );
}
