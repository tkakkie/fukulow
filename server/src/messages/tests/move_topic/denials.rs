use super::*;

async fn no_effect(
    pool: &PgPool,
    f: &Fixture,
    channel: Uuid,
    status: StatusCode,
    code: &str,
    call: impl Future<Output = Response>,
) {
    f.state.message_delivery.flush().await;
    let mut queue = f.state.message_delivery.queue(f.org, (f.sender, 0), 256);
    queue.subscribe(channel);
    let before = state(pool, f.org, channel).await;
    error(call.await, status, code).await;
    assert_eq!(state(pool, f.org, channel).await, before);
    f.state.message_delivery.flush().await;
    assert!(queue.events.try_recv().is_err());
    assert!(!queue.notification_failed.is_failed());
}

async fn role(pool: &PgPool, org: Uuid, member: Uuid, role: &str) {
    sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(member)
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
}

async fn grant(pool: &PgPool, org: Uuid, channel: Uuid, member: Uuid, manager: bool) {
    sqlx::query("INSERT INTO channel_members(organization_id,channel_id,member_id,manager) VALUES($1,$2,$3,$4)")
        .bind(org).bind(channel).bind(member).bind(manager).execute(pool).await.unwrap();
}

#[fukulow_test::test]
async fn move_denies_visible_guest_even_on_own_chain(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    grant(&pool, f.org, f.channel, f.sender, false).await;
    role(&pool, f.org, f.sender, "guest").await;
    let root = f.root().await;
    let intent = named(1, "Target");
    no_effect(
        &pool,
        &f,
        f.channel,
        StatusCode::FORBIDDEN,
        "move_not_allowed",
        move_request(&f.app, &f.token, f.channel, id(&root), intent.clone()),
    )
    .await;
    role(&pool, f.org, f.sender, "member").await;
    assert_eq!(
        moved(move_request(&f.app, &f.token, f.channel, id(&root), intent).await)
            .await
            .move_seq,
        Some(2)
    );
}

#[fukulow_test::test]
async fn move_denies_member_if_any_sender_differs_even_for_a_tombstone(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let peer = Uuid::new_v4();
    let peer_token = member(&pool, f.org, peer).await;
    let root = f.root().await;
    let child = f.post(&peer_token, reply(Uuid::new_v4(), &root)).await;
    let intent = named(2, "Target");
    for deleted in [false, true] {
        if deleted {
            mark_tombstone(&pool, &f, &child).await;
        }
        no_effect(
            &pool,
            &f,
            f.channel,
            StatusCode::FORBIDDEN,
            "move_not_allowed",
            move_request(&f.app, &f.token, f.channel, id(&root), intent.clone()),
        )
        .await;
    }
    role(&pool, f.org, peer, "admin").await;
    let outcome =
        moved(move_request(&f.app, &peer_token, f.channel, id(&root), intent).await).await;
    assert_eq!(outcome.move_seq, Some(3));
}

#[fukulow_test::test]
async fn move_denies_owner_and_admin_without_private_grant_and_accepts_current_grant(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let private = Uuid::new_v4();
    channel(&pool, f.org, private, f.sender, true).await;
    let root = sent(&f.app, &f.token, private, input(Uuid::new_v4(), "private")).await;
    let mut version = 1;
    for role_name in ["owner", "admin"] {
        let actor = Uuid::new_v4();
        let token = member(&pool, f.org, actor).await;
        role(&pool, f.org, actor, role_name).await;
        let intent = named(version, role_name);
        no_effect(
            &pool,
            &f,
            private,
            StatusCode::NOT_FOUND,
            "channel not found",
            move_request(&f.app, &token, private, id(&root), intent.clone()),
        )
        .await;
        grant(&pool, f.org, private, actor, false).await;
        let outcome = moved(move_request(&f.app, &token, private, id(&root), intent).await).await;
        version += 1;
        assert_eq!(outcome.move_seq, Some(version));
    }
}

#[fukulow_test::test]
async fn move_private_manager_right_is_rechecked_on_canonical_retry(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let private = Uuid::new_v4();
    channel(&pool, f.org, private, f.sender, true).await;
    let manager = Uuid::new_v4();
    let token = member(&pool, f.org, manager).await;
    grant(&pool, f.org, private, manager, true).await;
    let root = sent(&f.app, &f.token, private, input(Uuid::new_v4(), "private")).await;
    let intent = named(1, "Target");
    let outcome =
        moved(move_request(&f.app, &token, private, id(&root), intent.clone()).await).await;
    assert_eq!(outcome.move_seq, Some(2));
    sqlx::query("UPDATE channel_members SET manager=false WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
        .bind(f.org).bind(private).bind(manager).execute(&pool).await.unwrap();
    no_effect(
        &pool,
        &f,
        private,
        StatusCode::FORBIDDEN,
        "move_not_allowed",
        move_request(&f.app, &token, private, id(&root), intent.clone()),
    )
    .await;
    sqlx::query("UPDATE channel_members SET manager=true WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
        .bind(f.org).bind(private).bind(manager).execute(&pool).await.unwrap();
    assert_eq!(
        moved(move_request(&f.app, &token, private, id(&root), intent).await)
            .await
            .move_seq,
        Some(2)
    );
}

#[fukulow_test::test]
async fn move_denies_visible_dm_with_ordinary_channel_control(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let peer = Uuid::new_v4();
    member(&pool, f.org, peer).await;
    let opened = request(
        &f.app,
        "POST",
        "/api/v1/dms",
        &f.token,
        json!({"member_id":peer}),
    )
    .await;
    assert_eq!(opened.status(), StatusCode::CREATED);
    let dm = id(&body(opened).await);
    let message = sent(&f.app, &f.token, dm, input(Uuid::new_v4(), "DM")).await;
    let intent = named(1, "Target");
    no_effect(
        &pool,
        &f,
        dm,
        StatusCode::FORBIDDEN,
        "move_not_allowed",
        move_request(&f.app, &f.token, dm, id(&message), intent.clone()),
    )
    .await;
    let root = f.root().await;
    assert_eq!(
        moved(move_request(&f.app, &f.token, f.channel, id(&root), intent).await)
            .await
            .move_seq,
        Some(2)
    );
}

#[fukulow_test::test]
async fn move_denies_cross_organization_with_authorized_control(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let other = Fixture::new(&pool).await;
    let root = f.root().await;
    let wrong_path = format!(
        "/api/v1/orgs/{}/channels/{}/messages/{}/move",
        f.org,
        f.channel,
        id(&root)
    );
    let intent = named(1, "Target");
    no_effect(
        &pool,
        &f,
        f.channel,
        StatusCode::NOT_FOUND,
        "organization_unavailable",
        request(&f.app, "POST", &wrong_path, &other.token, intent.clone()),
    )
    .await;
    assert_eq!(
        moved(move_request(&f.app, &f.token, f.channel, id(&root), intent).await)
            .await
            .move_seq,
        Some(2)
    );
}

#[fukulow_test::test]
async fn move_denies_inaccessible_channel_and_foreign_or_unknown_message_and_topic(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let private = Uuid::new_v4();
    channel(&pool, f.org, private, f.sender, true).await;
    let stranger = member(&pool, f.org, Uuid::new_v4()).await;
    let foreign = sent(
        &f.app,
        &f.token,
        private,
        json!({
            "client_message_id":Uuid::new_v4(), "body":"private", "topic_name":"Private",
        }),
    )
    .await;
    let other = Fixture::new(&pool).await;
    let external = other.root().await;
    let root = f.root().await;
    let intent = named(1, "Target");
    for channel in [private, Uuid::new_v4()] {
        no_effect(
            &pool,
            &f,
            channel,
            StatusCode::NOT_FOUND,
            "channel not found",
            move_request(&f.app, &stranger, channel, id(&foreign), intent.clone()),
        )
        .await;
    }
    for unknown in [id(&foreign), id(&external), Uuid::new_v4()] {
        no_effect(
            &pool,
            &f,
            f.channel,
            StatusCode::NOT_FOUND,
            "reply_chain_not_found",
            move_request(&f.app, &f.token, f.channel, unknown, intent.clone()),
        )
        .await;
    }
    for topic in [foreign["topic_id"].clone(), json!(Uuid::new_v4())] {
        let input =
            json!({"operation_id": intent["operation_id"], "expected_version":1, "topic_id":topic});
        no_effect(
            &pool,
            &f,
            f.channel,
            StatusCode::NOT_FOUND,
            "topic_not_found",
            move_request(&f.app, &f.token, f.channel, id(&root), input),
        )
        .await;
    }
    assert_eq!(
        moved(move_request(&f.app, &f.token, f.channel, id(&root), intent).await)
            .await
            .move_seq,
        Some(2)
    );
}

#[fukulow_test::test]
async fn move_stale_chain_version_writes_nothing_and_matching_version_succeeds(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let root = f.root().await;
    let child = f.post(&f.token, reply(Uuid::new_v4(), &root)).await;
    let mut intent = named(1, "Target");
    no_effect(
        &pool,
        &f,
        f.channel,
        StatusCode::CONFLICT,
        "version_conflict",
        move_request(&f.app, &f.token, f.channel, id(&root), intent.clone()),
    )
    .await;
    intent["expected_version"] = json!(2);
    assert_eq!(
        moved(move_request(&f.app, &f.token, f.channel, id(&child), intent).await)
            .await
            .move_seq,
        Some(3)
    );
}

#[fukulow_test::test]
async fn move_operation_conflict_and_canonical_retry_do_not_allocate_or_publish(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let root = f.root().await;
    let intent = named(1, "TaRGeT");
    let initial =
        moved(move_request(&f.app, &f.token, f.channel, id(&root), intent.clone()).await).await;
    let mut conflict = intent.clone();
    conflict["topic_name"] = json!("Different");
    no_effect(
        &pool,
        &f,
        f.channel,
        StatusCode::CONFLICT,
        "operation_conflict",
        move_request(&f.app, &f.token, f.channel, id(&root), conflict),
    )
    .await;
    let mut retry = intent.clone();
    retry["topic_name"] = json!("target");
    let before = state(&pool, f.org, f.channel).await;
    let mut queue = f.state.message_delivery.queue(f.org, (f.sender, 0), 256);
    queue.subscribe(f.channel);
    let result =
        moved(move_request(&f.app, &f.token, f.channel, id(&root), retry.clone()).await).await;
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        serde_json::to_value(&initial).unwrap()
    );
    assert_eq!(state(&pool, f.org, f.channel).await, before);
    f.state.message_delivery.flush().await;
    assert!(queue.events.try_recv().is_err());

    let later = moved(
        move_request(
            &f.app,
            &f.token,
            f.channel,
            id(&root),
            named(2, "Elsewhere"),
        )
        .await,
    )
    .await;
    let replay = moved(move_request(&f.app, &f.token, f.channel, id(&root), retry).await).await;
    assert_eq!(replay.move_seq, Some(2));
    assert_eq!(replay.destination_topic_id, initial.destination_topic_id);
    assert_eq!(replay.operation_version, 2);
    assert_eq!(replay.chain_version, 3);
    assert_eq!(replay.topic_id, later.destination_topic_id);
}

#[fukulow_test::test]
async fn move_same_topic_records_only_replay_receipt_and_never_allocates_or_publishes(
    pool: PgPool,
) {
    let f = Fixture::new(&pool).await;
    let root = f
        .post(
            &f.token,
            json!({"client_message_id":Uuid::new_v4(),"body":"same", "topic_name":"Existing"}),
        )
        .await;
    f.state.message_delivery.flush().await;
    let mut queue = f.state.message_delivery.queue(f.org, (f.sender, 0), 256);
    queue.subscribe(f.channel);
    let before = state(&pool, f.org, f.channel).await;
    let intent = named(1, "EXISTING");
    for _ in 0..2 {
        let result =
            moved(move_request(&f.app, &f.token, f.channel, id(&root), intent.clone()).await).await;
        assert_eq!(result.move_seq, None);
        assert_eq!(result.operation_version, 1);
        assert_eq!(json!(result.topic_id), root["topic_id"]);
    }
    let mut after = state(&pool, f.org, f.channel).await;
    assert_eq!(after[4].as_array().unwrap().len(), 1);
    after[4] = Value::Null;
    assert_eq!(after, before);
    f.state.message_delivery.flush().await;
    assert!(queue.events.try_recv().is_err());
    let mut conflict = intent.clone();
    conflict["topic_name"] = json!("Other");
    no_effect(
        &pool,
        &f,
        f.channel,
        StatusCode::CONFLICT,
        "operation_conflict",
        move_request(&f.app, &f.token, f.channel, id(&root), conflict),
    )
    .await;
    assert_eq!(
        moved(move_request(&f.app, &f.token, f.channel, id(&root), named(1, "Other")).await)
            .await
            .move_seq,
        Some(2)
    );
    let retry = moved(move_request(&f.app, &f.token, f.channel, id(&root), intent).await).await;
    assert!(retry.move_seq.is_none());
    assert_eq!(retry.chain_version, 2);
    assert_eq!(json!(retry.destination_topic_id), root["topic_id"]);
}

#[fukulow_test::test]
async fn move_limit_counts_tombstones_and_accepts_exactly_one_thousand(pool: PgPool) {
    for size in [1_000_i64, 1_001] {
        let f = Fixture::new(&pool).await;
        let root = f.root().await;
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("INSERT INTO messages(organization_id,channel_id,id,seq,sender,client_message_id,body,reply_to_id,reply_root_id,deleted)
                    SELECT $1,$2,gen_random_uuid(),n,$3,gen_random_uuid(),'Reply',$4,$4,n=$5
                    FROM generate_series(2,$5) n")
            .bind(f.org).bind(f.channel).bind(f.sender).bind(id(&root)).bind(size)
            .execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO channel_log(organization_id,channel_id,event_seq,kind,message_id,sender,client_message_id)
                    SELECT organization_id,channel_id,seq,'create',id,sender,client_message_id
                    FROM messages WHERE organization_id=$1 AND channel_id=$2 AND seq>1")
            .bind(f.org).bind(f.channel).execute(&mut *tx).await.unwrap();
        sqlx::query("UPDATE channel_message_sequences SET seq=$3 WHERE organization_id=$1 AND channel_id=$2")
            .bind(f.org).bind(f.channel).bind(size).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        let call = move_request(&f.app, &f.token, f.channel, id(&root), named(size, "Large"));
        if size == 1_001 {
            no_effect(
                &pool,
                &f,
                f.channel,
                StatusCode::CONFLICT,
                "chain_too_large",
                call,
            )
            .await;
            archive::owner(&pool, &f).await;
            assert_eq!(
                archive::patch_archive(&f.app, &f.token, f.channel, true)
                    .await
                    .status(),
                StatusCode::NO_CONTENT
            );
            no_effect(
                &pool,
                &f,
                f.channel,
                StatusCode::CONFLICT,
                "channel_archived",
                move_request(&f.app, &f.token, f.channel, id(&root), named(size, "Large")),
            )
            .await;
        } else {
            let result = moved(call.await).await;
            assert_eq!(result.move_seq, Some(size + 1));
            let messages: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM messages WHERE organization_id=$1 AND channel_id=$2 AND topic_id=$3 AND version=$4")
                .bind(f.org).bind(f.channel).bind(result.destination_topic_id).bind(size+1)
                .fetch_one(&pool).await.unwrap();
            assert_eq!(messages, size);
        }
    }
}

#[fukulow_test::test]
async fn move_retry_rechecks_ownership_past_the_oversized_chain_prefix(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let root = f.root().await;
    let intent = named(1, "Target");
    let committed =
        moved(move_request(&f.app, &f.token, f.channel, id(&root), intent.clone()).await).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query(
        "INSERT INTO messages(organization_id,channel_id,id,seq,sender,client_message_id,body,topic_id,reply_to_id,reply_root_id)
         SELECT $1,$2,gen_random_uuid(),n,$3,gen_random_uuid(),'Reply',$4,$5,$5 FROM generate_series(3,1002) n",
    )
    .bind(f.org).bind(f.channel).bind(f.sender)
    .bind(committed.destination_topic_id).bind(id(&root))
    .execute(&mut *tx).await.unwrap();
    sqlx::query(
        "INSERT INTO channel_log(organization_id,channel_id,event_seq,kind,message_id,sender,client_message_id)
         SELECT organization_id,channel_id,seq,'create',id,sender,client_message_id
         FROM messages WHERE organization_id=$1 AND channel_id=$2 AND seq>2",
    )
    .bind(f.org).bind(f.channel).execute(&mut *tx).await.unwrap();
    sqlx::query(
        "UPDATE channel_message_sequences SET seq=1002 WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(f.org)
    .bind(f.channel)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("UPDATE topics SET last_seq=1002, message_count=1001 WHERE organization_id=$1 AND channel_id=$2 AND id=$3")
        .bind(f.org).bind(f.channel).bind(committed.destination_topic_id)
        .execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();

    let before = state(&pool, f.org, f.channel).await;
    let retry =
        moved(move_request(&f.app, &f.token, f.channel, id(&root), intent.clone()).await).await;
    assert_eq!(retry.move_seq, committed.move_seq);
    assert_eq!(retry.chain_version, 1002);
    assert_eq!(retry.destination_topic_id, committed.destination_topic_id);
    assert_eq!(state(&pool, f.org, f.channel).await, before);

    let peer = member(&pool, f.org, Uuid::new_v4()).await;
    let later = f.post(&peer, reply(Uuid::new_v4(), &root)).await;
    assert_eq!(later["created_seq"], 1003);
    no_effect(
        &pool,
        &f,
        f.channel,
        StatusCode::FORBIDDEN,
        "move_not_allowed",
        move_request(&f.app, &f.token, f.channel, id(&root), intent),
    )
    .await;
}

#[fukulow_test::test]
async fn move_denies_guest_even_if_private_grant_carries_a_manager_flag(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let private = Uuid::new_v4();
    channel(&pool, f.org, private, f.sender, true).await;
    let root = sent(&f.app, &f.token, private, input(Uuid::new_v4(), "Private")).await;
    let guest = Uuid::new_v4();
    let guest_token = member(&pool, f.org, guest).await;
    role(&pool, f.org, guest, "guest").await;
    grant(&pool, f.org, private, guest, false).await;
    // Exercise the authorization defense against an inconsistent persisted grant.
    // Ordinary writes cannot set a manager flag for a Guest.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("ALTER TABLE channel_members DISABLE TRIGGER channel_members_manager")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE channel_members SET manager=true WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
        .bind(f.org).bind(private).bind(guest).execute(&mut *tx).await.unwrap();
    sqlx::query("ALTER TABLE channel_members ENABLE TRIGGER channel_members_manager")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let intent = named(1, "Target");
    no_effect(
        &pool,
        &f,
        private,
        StatusCode::FORBIDDEN,
        "move_not_allowed",
        move_request(&f.app, &guest_token, private, id(&root), intent.clone()),
    )
    .await;
    let manager = Uuid::new_v4();
    let manager_token = member(&pool, f.org, manager).await;
    grant(&pool, f.org, private, manager, true).await;
    assert_eq!(
        moved(move_request(&f.app, &manager_token, private, id(&root), intent).await,)
            .await
            .move_seq,
        Some(2)
    );
}

#[fukulow_test::test]
async fn move_requires_one_destination_selector(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let root = f.root().await;
    let intent = named(1, "Target");
    for input in [
        json!({"expected_version":1,"operation_id":intent["operation_id"]}),
        json!({"expected_version":1,"operation_id":intent["operation_id"],"topic_name":"Target","topic_id":Uuid::new_v4()}),
    ] {
        no_effect(
            &pool,
            &f,
            f.channel,
            StatusCode::BAD_REQUEST,
            "invalid input",
            move_request(&f.app, &f.token, f.channel, id(&root), input),
        )
        .await;
    }
    assert_eq!(
        moved(move_request(&f.app, &f.token, f.channel, id(&root), intent).await,)
            .await
            .move_seq,
        Some(2)
    );
}
