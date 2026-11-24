use super::*;

pub(super) async fn owner(pool: &PgPool, f: &Fixture) {
    sqlx::query("UPDATE users SET role='owner' WHERE organization_id=$1 AND id=$2")
        .bind(f.org)
        .bind(f.sender)
        .execute(pool)
        .await
        .unwrap();
}

pub(super) async fn patch_archive(
    app: &Router,
    token: &str,
    channel: Uuid,
    archived: bool,
) -> Response {
    request(
        app,
        "PATCH",
        &format!("/api/v1/channels/{channel}"),
        token,
        json!({"archived":archived}),
    )
    .await
}

#[derive(Clone, Copy)]
enum Writer {
    Send(Uuid),
    Move(Uuid),
}

async fn write(f: &Fixture, root: Uuid, writer: Writer) -> Response {
    match writer {
        Writer::Send(key) => send(&f.app, &f.token, f.channel, input(key, "new Message")).await,
        Writer::Move(operation_id) => move_request(
            &f.app,
            &f.token,
            f.channel,
            root,
            json!({"operation_id":operation_id,"expected_version":1,"topic_name":"Destination"}),
        )
        .await,
    }
}

async fn assert_both_commit_orders(pool: &PgPool, writer: Writer) {
    let f = std::sync::Arc::new(Fixture::new(pool).await);
    owner(pool, &f).await;
    let root = id(&f.root().await);
    let before = state(pool, f.org, f.channel).await;
    let key = match writer {
        Writer::Send(key) | Writer::Move(key) => key,
    };
    let gate = pause_commit(key);
    let write_task = tokio::spawn({
        let f = f.clone();
        async move { write(&f, root, writer).await }
    });
    gate.entered_within(Duration::from_secs(3)).await;
    let archive_task = tokio::spawn({
        let f = f.clone();
        async move { patch_archive(&f.app, &f.token, f.channel, true).await }
    });
    races::wait_for_lock(pool, "%archived_at%FOR NO KEY UPDATE").await;
    assert_eq!(state(pool, f.org, f.channel).await, before);
    gate.release();
    let response = write_task.await.unwrap();
    assert_eq!(
        response.status(),
        match writer {
            Writer::Send(_) => StatusCode::CREATED,
            Writer::Move(_) => StatusCode::OK,
        }
    );
    let outcome = body(response).await;
    assert_eq!(archive_task.await.unwrap().status(), StatusCode::NO_CONTENT);
    let committed = state(pool, f.org, f.channel).await;
    assert_eq!(committed[3].as_array().unwrap().len(), 2);
    assert_eq!(body(write(&f, root, writer).await).await, outcome);
    assert_eq!(state(pool, f.org, f.channel).await, committed);

    let f = std::sync::Arc::new(Fixture::new(pool).await);
    owner(pool, &f).await;
    let root = id(&f.root().await);
    let before = state(pool, f.org, f.channel).await;
    // Hold the actual archive UPDATE after it has acquired its Channel lock.
    sqlx::raw_sql(
        "CREATE FUNCTION pause_archive() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN PERFORM pg_advisory_xact_lock(410); RETURN NEW; END $$;
         CREATE TRIGGER pause_archive BEFORE UPDATE OF archived_at ON channels
           FOR EACH ROW EXECUTE FUNCTION pause_archive()",
    )
    .execute(pool)
    .await
    .unwrap();
    let mut blocker = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(410)")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let archive_task = tokio::spawn({
        let f = f.clone();
        async move { patch_archive(&f.app, &f.token, f.channel, true).await }
    });
    races::wait_for_lock(pool, "%UPDATE channels SET archived_at%").await;
    let write_task = tokio::spawn({
        let f = f.clone();
        async move { write(&f, root, writer).await }
    });
    races::wait_for_lock(pool, "%archived_at%FOR SHARE").await;
    blocker.commit().await.unwrap();
    assert_eq!(archive_task.await.unwrap().status(), StatusCode::NO_CONTENT);
    error(
        write_task.await.unwrap(),
        StatusCode::CONFLICT,
        "channel_archived",
    )
    .await;
    assert_eq!(state(pool, f.org, f.channel).await, before);
    assert_eq!(
        patch_archive(&f.app, &f.token, f.channel, false)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert!(write(&f, root, writer).await.status().is_success());
    assert_eq!(
        state(pool, f.org, f.channel).await[3]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[fukulow_test::test]
async fn send_and_archive_serialize_in_both_orders(pool: PgPool) {
    assert_both_commit_orders(&pool, Writer::Send(Uuid::new_v4())).await;
}

#[fukulow_test::test]
async fn move_and_archive_serialize_in_both_orders(pool: PgPool) {
    assert_both_commit_orders(&pool, Writer::Move(Uuid::new_v4())).await;
}

#[fukulow_test::test]
async fn archive_send_and_move_conflict_precedence(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    owner(&pool, &f).await;
    let other = member(&pool, f.org, Uuid::new_v4()).await;
    let original = input(Uuid::new_v4(), "root");
    let root = f.post(&f.token, original.clone()).await;
    let movement = named(1, "Moved");
    let outcome =
        moved(move_request(&f.app, &f.token, f.channel, id(&root), movement.clone()).await).await;
    assert_eq!(
        patch_archive(&f.app, &f.token, f.channel, true)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let snapshot = state(&pool, f.org, f.channel).await;
    // The S5 receipt is fixed at creation while the canonical response is current.
    let canonical = f.post(&f.token, original.clone()).await;
    assert_eq!(canonical["id"], root["id"]);
    assert_eq!(canonical["topic_id"], json!(outcome.destination_topic_id));
    let mut changed = original.clone();
    changed["body"] = json!("changed");
    error(
        send(&f.app, &f.token, f.channel, changed).await,
        StatusCode::CONFLICT,
        "client message id reused with different body, channel, Topic or reply target",
    )
    .await;
    let mut stale = original.clone();
    stale["history_generation"] = json!(Uuid::new_v4());
    error(
        send(&f.app, &f.token, f.channel, stale).await,
        StatusCode::CONFLICT,
        "history_generation_changed",
    )
    .await;
    for fresh in [
        input(Uuid::new_v4(), "Message"),
        reply(Uuid::new_v4(), &root),
        json!({"client_message_id":Uuid::new_v4(),"body":"first","topic_name":"New Topic"}),
    ] {
        error(
            send(&f.app, &f.token, f.channel, fresh).await,
            StatusCode::CONFLICT,
            "channel_archived",
        )
        .await;
    }

    let repeated =
        moved(move_request(&f.app, &f.token, f.channel, id(&root), movement.clone()).await).await;
    assert_eq!(repeated.move_seq, outcome.move_seq);
    let mut changed = movement.clone();
    changed["topic_name"] = json!("Different");
    error(
        move_request(&f.app, &f.token, f.channel, id(&root), changed).await,
        StatusCode::CONFLICT,
        "operation_conflict",
    )
    .await;
    let mut stale = movement;
    stale["history_generation"] = json!(Uuid::new_v4());
    error(
        move_request(&f.app, &f.token, f.channel, id(&root), stale).await,
        StatusCode::CONFLICT,
        "history_generation_changed",
    )
    .await;
    error(
        move_request(&f.app, &other, f.channel, id(&root), named(1, "New")).await,
        StatusCode::FORBIDDEN,
        "move_not_allowed",
    )
    .await;
    error(
        move_request(&f.app, &f.token, f.channel, Uuid::new_v4(), named(1, "New")).await,
        StatusCode::NOT_FOUND,
        "reply_chain_not_found",
    )
    .await;
    error(
        move_request(&f.app, &f.token, f.channel, id(&root), named(1, "New")).await,
        StatusCode::CONFLICT,
        "channel_archived",
    )
    .await;
    assert_eq!(state(&pool, f.org, f.channel).await, snapshot);
}

#[fukulow_test::test]
async fn archived_send_denies_before_the_limiter_without_charging(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    owner(&pool, &f).await;
    let mut state = f.state.clone();
    state.message_delivery =
        Delivery::with_send_limit(SendLimit::configured(Some("1"), None).unwrap());
    let limiter = state.message_delivery.send_limiter.enforce();
    let app = crate::app(state.clone());
    let fresh = input(Uuid::new_v4(), "First");
    assert_eq!(
        patch_archive(&app, &f.token, f.channel, true)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    error(
        send(&app, &f.token, f.channel, fresh.clone()).await,
        StatusCode::CONFLICT,
        "channel_archived",
    )
    .await;
    assert_eq!(
        patch_archive(&app, &f.token, f.channel, false)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let canonical = sent(&app, &f.token, f.channel, fresh.clone()).await;
    let second = input(Uuid::new_v4(), "Second");
    error(
        send(&app, &f.token, f.channel, second.clone()).await,
        StatusCode::TOO_MANY_REQUESTS,
        "send_rate_limited",
    )
    .await;
    assert_eq!(
        patch_archive(&app, &f.token, f.channel, true)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    error(
        send(&app, &f.token, f.channel, second.clone()).await,
        StatusCode::CONFLICT,
        "channel_archived",
    )
    .await;
    assert_eq!(sent(&app, &f.token, f.channel, fresh).await, canonical);
    assert_eq!(
        patch_archive(&app, &f.token, f.channel, false)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    limiter.advance(Duration::from_secs(1));
    assert_eq!(
        sent(&app, &f.token, f.channel, second).await["created_seq"],
        2
    );
}
