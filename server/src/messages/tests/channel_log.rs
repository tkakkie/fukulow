use super::*;

async fn positions(pool: &PgPool, org: Uuid, channel: Uuid) -> Vec<i64> {
    sqlx::query_scalar(
        "SELECT seq FROM messages WHERE organization_id=$1 AND channel_id=$2 ORDER BY seq",
    )
    .bind(org)
    .bind(channel)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[fukulow_test::test]
async fn channel_log_concurrent_sends_and_duplicate_retries_append_exactly_once(pool: PgPool) {
    let (app, org, _, channel, token) = fixture(&pool).await;
    let key = Uuid::new_v4();
    let sends = (0..24).map(|n| {
        let app = &app;
        let token = &token;
        async move {
            sent(
                app,
                token,
                channel,
                input(if n < 8 { key } else { Uuid::new_v4() }, "send"),
            )
            .await
        }
    });
    let results = futures_util::future::join_all(sends).await;
    for duplicate in &results[..8] {
        assert_eq!(duplicate, &results[0]);
    }
    assert_eq!(
        sent(&app, &token, channel, input(key, "send")).await,
        results[0]
    );
    assert_eq!(
        positions(&pool, org, channel).await,
        (1..=17).collect::<Vec<_>>()
    );
    let mutations: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM channel_log WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(org)
    .bind(channel)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(mutations, 0);
}

#[fukulow_test::test]
async fn channel_log_failure_rolls_back_message_counter_and_topic(pool: PgPool) {
    let (app, org, _, channel, token) = fixture(&pool).await;
    sqlx::raw_sql(
        "CREATE FUNCTION fail_create_commit() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'injected failure after Message insertion'; END $$;
         CREATE CONSTRAINT TRIGGER fail_create_commit AFTER INSERT ON messages
         DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_create_commit();",
    )
    .execute(&pool)
    .await
    .unwrap();
    let key = Uuid::new_v4();
    let value = json!({"client_message_id":key,"body":"rollback","topic_name":"Rollback"});
    assert_eq!(
        send(&app, &token, channel, value.clone()).await.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert!(positions(&pool, org, channel).await.is_empty());
    for table in ["messages", "topics", "channel_message_sequences"] {
        let count: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM {table} WHERE organization_id=$1 AND channel_id=$2"
        ))
        .bind(org)
        .bind(channel)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 0, "{table}");
    }
    sqlx::query("DROP TRIGGER fail_create_commit ON messages")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(sent(&app, &token, channel, value).await["created_seq"], 1);
    assert_eq!(positions(&pool, org, channel).await, [1]);
}

#[fukulow_test::test]
async fn channel_log_reconciles_current_body_and_fails_closed_on_missing_state(pool: PgPool) {
    let (app, org, sender, channel, token) = fixture(&pool).await;
    for _ in 0..3 {
        sent(&app, &token, channel, input(Uuid::new_v4(), "original")).await;
    }
    let app_pool = crate::test_app_pool(pool.clone()).await;
    sqlx::query(
        "UPDATE messages SET body='current', version=3 WHERE organization_id=$1 AND channel_id=$2 AND seq=2",
    )
    .bind(org)
    .bind(channel)
    .execute(&pool)
    .await
    .unwrap();
    let page = authorized_replay_page(&app_pool, org, (sender, 0), channel, 0, 3)
        .await
        .unwrap();
    assert_eq!(
        page.iter()
            .map(|m| m.message().created_seq)
            .collect::<Vec<_>>(),
        [1, 2, 3]
    );
    assert_eq!(page[1].message().body.as_deref(), Some("current"));
    assert_eq!(
        (
            page[1].seq,
            page[1].message().created_seq,
            page[1].message().version
        ),
        (2, 2, 3)
    );
    sqlx::query("DELETE FROM messages WHERE organization_id=$1 AND channel_id=$2 AND seq=2")
        .bind(org)
        .bind(channel)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(positions(&pool, org, channel).await, [1, 3]);
    assert!(matches!(
        replay_page(&app_pool, org, channel, 0, 3).await,
        Err(sqlx::Error::RowNotFound)
    ));
    assert!(matches!(
        authorized_replay_page(&app_pool, org, (sender, 0), channel, 0, 3).await,
        Err(MessageError::Database(sqlx::Error::RowNotFound))
    ));

    let delivery = Delivery::default();
    let mut queue = delivery.queue(org, (sender, 0), 256);
    queue.subscribe(channel);
    let mut early = delivery.notification(org, channel, 1);
    early.complete();
    delivery
        .notification(org, channel, 3)
        .spawn(app_pool, page[2].clone());
    delivery.flush().await;
    assert!(queue.notification_failed.is_failed());
    assert!(queue.events.try_recv().is_err());
}

#[fukulow_test::test]
async fn channel_log_runtime_denies_update_delete_and_truncate_with_read_insert_controls(
    pool: PgPool,
) {
    let (app, org, sender, channel, token) = fixture(&pool).await;
    sent(&app, &token, channel, input(Uuid::new_v4(), "control")).await;
    let app_pool = crate::test_app_pool(pool.clone()).await;
    crate::database::organization(&app_pool, org, async |tx: &mut sqlx::PgConnection| {
        sqlx::query("INSERT INTO channel_log (organization_id,channel_id,event_seq,kind,message_id,sender,operation_id,destination_topic_id)
                     SELECT organization_id,channel_id,2,'move',id,sender,gen_random_uuid(),gen_random_uuid()
                     FROM messages WHERE organization_id=$1 AND channel_id=$2 AND sender=$3")
            .bind(org).bind(channel).bind(sender).execute(&mut *tx).await?;
        assert_eq!(mutation_positions(tx, org, channel).await?, [2]);
        Ok::<_, sqlx::Error>(())
    })
    .await
    .unwrap();
    for sql in [
        "UPDATE channel_log SET kind=kind",
        "DELETE FROM channel_log",
        "TRUNCATE channel_log",
    ] {
        let error =
            crate::database::organization(&app_pool, org, async |tx: &mut sqlx::PgConnection| {
                sqlx::query(sql).execute(tx).await
            })
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("42501"),
            "{sql}"
        );
    }
    // Even with UPDATE/DELETE granted (grants step not yet run), RLS has no
    // policy for them, so the log stays append-only.
    sqlx::query("GRANT UPDATE, DELETE ON channel_log TO fukulow_sqlx_test_app")
        .execute(&pool)
        .await
        .unwrap();
    crate::database::organization(&app_pool, org, async |tx: &mut sqlx::PgConnection| {
        for sql in [
            "UPDATE channel_log SET kind=kind",
            "DELETE FROM channel_log",
        ] {
            assert_eq!(
                sqlx::query(sql).execute(&mut *tx).await?.rows_affected(),
                0,
                "{sql}"
            );
        }
        Ok::<_, sqlx::Error>(())
    })
    .await
    .unwrap();
    let mut owner = pool.acquire().await.unwrap();
    assert_eq!(
        mutation_positions(&mut owner, org, channel).await.unwrap(),
        [2]
    );
}

async fn mutation_positions(
    tx: &mut sqlx::PgConnection,
    org: Uuid,
    channel: Uuid,
) -> Result<Vec<i64>, sqlx::Error> {
    sqlx::query_scalar("SELECT event_seq FROM channel_log WHERE organization_id=$1 AND channel_id=$2 ORDER BY event_seq")
        .bind(org).bind(channel).fetch_all(tx).await
}

#[fukulow_test::test(migrations = false)]
async fn channel_log_migration_backfills_existing_messages_and_scopes_foreign_keys(pool: PgPool) {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut paths = std::fs::read_dir(directory)
        .unwrap()
        .map(|p| p.unwrap().path())
        .filter(|p| p.file_name().unwrap().to_str().unwrap() < "202611170515_channel_log.sql")
        .collect::<Vec<_>>();
    paths.sort();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&pool)
            .await
            .unwrap();
    }
    let (_, org, sender, channel, _) = fixture(&pool).await;
    sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body) SELECT $1,$2,gen_random_uuid(),n,$3,gen_random_uuid(),'before log' FROM generate_series(1,3) n")
        .bind(org).bind(channel).bind(sender).execute(&pool).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../migrations/202611170515_channel_log.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    let mut owner = pool.acquire().await.unwrap();
    assert_eq!(
        mutation_positions(&mut owner, org, channel).await.unwrap(),
        [1, 2, 3]
    );
    let mismatch: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM messages m FULL JOIN channel_log l ON l.organization_id=m.organization_id AND l.channel_id=m.channel_id AND l.event_seq=m.seq \
         WHERE m.id IS DISTINCT FROM l.message_id OR l.kind IS DISTINCT FROM 'create' OR m.sender IS DISTINCT FROM l.sender OR m.client_message_id IS DISTINCT FROM l.client_message_id",
    ).fetch_one(&pool).await.unwrap();
    assert_eq!(mismatch, 0);
    let foreign = organization(&pool).await;
    let foreign_sender = Uuid::new_v4();
    member(&pool, foreign, foreign_sender).await;
    for (scope, target, author) in [
        (foreign, channel, foreign_sender),
        (org, channel, foreign_sender),
    ] {
        let error = sqlx::query("INSERT INTO channel_log (organization_id,channel_id,event_seq,kind,message_id,sender,client_message_id) VALUES ($1,$2,4,'create',gen_random_uuid(),$3,gen_random_uuid())")
            .bind(scope).bind(target).bind(author).execute(&pool).await.unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23503")
        );
    }
}

async fn event_response(app: &Router, token: &str, channel: Uuid, query: &str) -> Response {
    request(
        app,
        "GET",
        &format!("/api/v1/channels/{channel}/events{query}"),
        token,
        Value::Null,
    )
    .await
}

#[fukulow_test::test]
async fn channel_event_pages_are_bounded_exclusive_and_hydrate_current_state(pool: PgPool) {
    let (app, org, sender, channel, token) = fixture(&pool).await;
    sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,version,sender,client_message_id,body) SELECT $1,gen_random_uuid(),$2,n,n,$3,gen_random_uuid(),'original' FROM generate_series(1,205) n")
        .bind(org).bind(channel).bind(sender).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO channel_message_sequences (organization_id,channel_id,seq) VALUES ($1,$2,205)",
    )
    .bind(org)
    .bind(channel)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE messages SET version=205,body='current' WHERE organization_id=$1 AND channel_id=$2 AND seq=2")
        .bind(org).bind(channel).execute(&pool).await.unwrap();
    for (query, expected, more) in [
        ("?after_seq=0", (1..=50).collect::<Vec<_>>(), true),
        ("?after_seq=0&limit=200", (1..=200).collect(), true),
        ("?after_seq=200&limit=5", (201..=205).collect(), false),
        ("?after_seq=201&limit=2", vec![202, 203], true),
        ("?after_seq=205", vec![], false),
        ("?after_seq=9223372036854775807", vec![], false),
    ] {
        let response = event_response(&app, &token, channel, query).await;
        assert_eq!(response.status(), StatusCode::OK, "{query}");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let page = body(response).await;
        let events = page["events"].as_array().unwrap();
        assert_eq!(
            events
                .iter()
                .map(|e| e["seq"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(page["has_more"], more);
        assert!(
            events
                .iter()
                .all(|e| e["type"] == "message" && e["kind"] == "create")
        );
        if let Some(event) = events.iter().find(|e| e["seq"] == 2) {
            assert_eq!(event["message"]["created_seq"], 2);
            assert_eq!(event["message"]["version"], 205);
            assert_eq!(event["message"]["body"], "current");
        }
    }
    // Directly inserted state beyond the captured watermark is not replayable yet.
    sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,version,sender,client_message_id,body) VALUES ($1,gen_random_uuid(),$2,206,206,$3,gen_random_uuid(),'not logged')")
        .bind(org).bind(channel).bind(sender).execute(&pool).await.unwrap();
    let page = body(event_response(&app, &token, channel, "?after_seq=205").await).await;
    assert_eq!(
        page,
        json!({"history_generation":page["history_generation"],"events":[],"has_more":false})
    );
    // Validate every limited position before acknowledging any part of its page.
    sqlx::query("DELETE FROM messages WHERE organization_id=$1 AND channel_id=$2 AND seq=2")
        .bind(org)
        .bind(channel)
        .execute(&pool)
        .await
        .unwrap();
    assert_error(
        event_response(&app, &token, channel, "?after_seq=0").await,
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
}

#[fukulow_test::test]
async fn channel_event_pages_deny_private_nonmembers_and_foreign_organizations_with_controls(
    pool: PgPool,
) {
    let (app, org, sender, public, token) = fixture(&pool).await;
    let private = Uuid::new_v4();
    channel(&pool, org, private, sender, true).await;
    sent(&app, &token, private, input(Uuid::new_v4(), "private")).await;
    sent(&app, &token, public, input(Uuid::new_v4(), "public")).await;
    let outsider = member(&pool, org, Uuid::new_v4()).await;
    let other_org = organization(&pool).await;
    let other_id = Uuid::new_v4();
    let other = member(&pool, other_org, other_id).await;
    // Reuse the same Channel id in a different Organization to test SQL scoping.
    channel(&pool, other_org, public, other_id, false).await;
    sent(&app, &other, public, input(Uuid::new_v4(), "foreign")).await;
    for (credential, target, expected) in [
        (&token, private, Some("private")),
        (&outsider, private, None),
        (&outsider, public, Some("public")),
        (&other, private, None),
        (&other, public, Some("foreign")),
        (&token, public, Some("public")),
    ] {
        let response = event_response(&app, credential, target, "?after_seq=0").await;
        if let Some(text) = expected {
            assert_eq!(response.status(), StatusCode::OK);
            let page = body(response).await;
            assert_eq!(page["events"].as_array().unwrap().len(), 1);
            assert_eq!(page["events"][0]["message"]["body"], text);
        } else {
            assert_error(response, StatusCode::NOT_FOUND).await;
        }
    }
    // Query validation precedes Channel disclosure; authentication precedes both.
    for query in [
        "",
        "?after_seq=-1",
        "?after_seq=x",
        "?after_seq=0&limit=0",
        "?after_seq=0&limit=201",
    ] {
        for target in [private, Uuid::new_v4()] {
            assert_error(
                event_response(&app, &outsider, target, query).await,
                StatusCode::BAD_REQUEST,
            )
            .await;
            assert_error(
                event_response(&app, &format!("{org}.invalid"), target, query).await,
                StatusCode::UNAUTHORIZED,
            )
            .await;
        }
    }
    let response = request(
        &app,
        "GET",
        &format!("/api/v1/orgs/{org}/channels/{private}/events?after_seq=0"),
        &other,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(body(response).await["error"], "organization_unavailable");
}

#[fukulow_test::test]
async fn channel_event_pages_fail_closed_on_missing_log_positions(pool: PgPool) {
    let (app, org, sender, channel, token) = fixture(&pool).await;
    for _ in 0..3 {
        sent(&app, &token, channel, input(Uuid::new_v4(), "original")).await;
    }
    // The owner removes the final position while leaving W at 3.
    sqlx::query("DELETE FROM messages WHERE organization_id=$1 AND channel_id=$2 AND seq=3")
        .bind(org)
        .bind(channel)
        .execute(&pool)
        .await
        .unwrap();
    assert_error(
        event_response(&app, &token, channel, "?after_seq=0").await,
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    let pool = crate::test_app_pool(pool).await;
    assert!(
        authorized_replay_page(&pool, org, (sender, 0), channel, 0, 3)
            .await
            .is_err()
    );
}

#[fukulow_test::test]
async fn channel_event_pages_exclude_uncommitted_tail_until_shared_watermark_advances(
    pool: PgPool,
) {
    let (app, org, sender, channel, token) = fixture(&pool).await;
    for _ in 0..9 {
        sent(&app, &token, channel, input(Uuid::new_v4(), "prefix")).await;
    }
    let mut lower = pool.begin().await.unwrap();
    // A3 count rows serialize Message inserts per Channel until commit (as the
    // counter does for real sends), so position 11 commits before 10 is written.
    for seq in [11, 10] {
        let id = Uuid::new_v4();
        let key = Uuid::new_v4();
        let mut upper = pool.begin().await.unwrap();
        let tx = if seq == 10 { &mut lower } else { &mut upper };
        sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,version,sender,client_message_id,body) VALUES ($1,$2,$3,$4,$4,$5,$6,'tail')")
            .bind(org).bind(id).bind(channel).bind(seq).bind(sender).bind(key).execute(&mut **tx).await.unwrap();
        upper.commit().await.unwrap();
    }
    // Position 11 is visible first, but the committed-prefix watermark remains 9.
    let response = event_response(&app, &token, channel, "?after_seq=9").await;
    assert_eq!(response.status(), StatusCode::OK);
    let page = body(response).await;
    assert!(Uuid::parse_str(page["history_generation"].as_str().unwrap()).is_ok());
    assert_eq!(
        page,
        json!({"history_generation":page["history_generation"],"events":[],"has_more":false})
    );
    sqlx::query(
        "UPDATE channel_message_sequences SET seq=11 WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(org)
    .bind(channel)
    .execute(&mut *lower)
    .await
    .unwrap();
    lower.commit().await.unwrap();
    let response = event_response(&app, &token, channel, "?after_seq=9").await;
    assert_eq!(response.status(), StatusCode::OK);
    let page = body(response).await;
    assert_eq!(
        page["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["seq"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        [10, 11]
    );
    assert_eq!(page["has_more"], false);
}

#[fukulow_test::test]
async fn channel_event_pages_deny_ungranted_public_guests_and_dm_nonparticipants_with_controls(
    pool: PgPool,
) {
    let (app, org, _, public, author) = fixture(&pool).await;
    sent(&app, &author, public, input(Uuid::new_v4(), "public")).await;
    let guest = Uuid::new_v4();
    let token = member(&pool, org, guest).await;
    sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(guest)
        .execute(&pool)
        .await
        .unwrap();
    assert_error(
        event_response(&app, &token, public, "?after_seq=0").await,
        StatusCode::NOT_FOUND,
    )
    .await;
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
    )
    .bind(org)
    .bind(public)
    .bind(guest)
    .execute(&pool)
    .await
    .unwrap();
    let control = event_response(&app, &token, public, "?after_seq=0").await;
    assert_eq!(control.status(), StatusCode::OK);
    assert_eq!(
        body(control).await["events"][0]["message"]["body"],
        "public"
    );

    let peer = Uuid::new_v4();
    let peer_token = member(&pool, org, peer).await;
    let dm = request(
        &app,
        "POST",
        "/api/v1/dms",
        &author,
        json!({"member_id":peer}),
    )
    .await;
    assert_eq!(dm.status(), StatusCode::CREATED);
    let dm: Uuid = body(dm).await["id"].as_str().unwrap().parse().unwrap();
    sent(&app, &author, dm, input(Uuid::new_v4(), "DM")).await;
    for role in ["member", "owner", "admin", "guest"] {
        let outsider = Uuid::new_v4();
        let token = member(&pool, org, outsider).await;
        sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(outsider)
            .bind(role)
            .execute(&pool)
            .await
            .unwrap();
        assert_error(
            event_response(&app, &token, dm, "?after_seq=0").await,
            StatusCode::NOT_FOUND,
        )
        .await;
        for participant in [&author, &peer_token] {
            let control = event_response(&app, participant, dm, "?after_seq=0").await;
            assert_eq!(control.status(), StatusCode::OK, "{role}");
            assert_eq!(body(control).await["events"][0]["message"]["body"], "DM");
        }
    }
}

#[fukulow_test::test]
async fn channel_event_pages_recheck_extracted_authorization_after_access_and_membership_loss(
    pool: PgPool,
) {
    for loss in [
        "private_grant",
        "guest_grant",
        "stale_grant",
        "deactivated",
        "reactivated",
        "removed",
    ] {
        let (app, org, sender, public, author) = fixture(&pool).await;
        let target = if loss == "private_grant" || loss == "stale_grant" {
            let private = Uuid::new_v4();
            channel(&pool, org, private, sender, true).await;
            private
        } else {
            public
        };
        sent(&app, &author, target, input(Uuid::new_v4(), "control")).await;
        let actor = Uuid::new_v4();
        let token = member(&pool, org, actor).await;
        if loss == "guest_grant" {
            sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(actor)
                .execute(&pool)
                .await
                .unwrap();
        }
        if loss.ends_with("grant") {
            sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)")
                .bind(org).bind(target).bind(actor).execute(&pool).await.unwrap();
        }
        let state = AppState::for_test(pool.clone()).await;
        let extracted = membership::captured_auth(&pool, &token).await;
        let control = event_response(&app, &token, target, "?after_seq=0").await;
        assert_eq!(control.status(), StatusCode::OK);
        assert_eq!(
            body(control).await["events"][0]["message"]["body"],
            "control"
        );
        match loss {
            "private_grant" | "guest_grant" => {
                sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                    .bind(org).bind(target).bind(actor).execute(&pool).await.unwrap();
            }
            "removed" => {
                // Missing Membership fault injection: production retains Member identities.
                sqlx::query("ALTER TABLE users DISABLE TRIGGER protect_member_identity")
                    .execute(&pool)
                    .await
                    .unwrap();
                sqlx::query(
                    "DELETE FROM channel_read_positions WHERE organization_id=$1 AND member_id=$2",
                )
                .bind(org)
                .bind(actor)
                .execute(&pool)
                .await
                .unwrap();
                sqlx::query("DELETE FROM users WHERE organization_id=$1 AND id=$2")
                    .bind(org)
                    .bind(actor)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            _ => {
                sqlx::query(
                    "UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2",
                )
                .bind(org)
                .bind(actor)
                .execute(&pool)
                .await
                .unwrap();
                if loss == "reactivated" || loss == "stale_grant" {
                    sqlx::query(
                        "UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2",
                    )
                    .bind(org)
                    .bind(actor)
                    .execute(&pool)
                    .await
                    .unwrap();
                }
            }
        }
        let response = super::super::log::list_channel_events(
            State(state),
            extracted,
            Ok(Path((org, target))),
            Ok(Query(fukulow_api::ListChannelEventsQuery {
                history_generation: None,
                after_seq: 0,
                limit: None,
            })),
        )
        .await
        .unwrap_err()
        .into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{loss}");
        assert_eq!(
            body(response).await["error"],
            if loss == "private_grant" || loss == "guest_grant" {
                "channel not found"
            } else {
                "organization_unavailable"
            }
        );
        if loss != "reactivated" {
            assert_error(
                event_response(&app, &token, target, "?after_seq=0").await,
                StatusCode::NOT_FOUND,
            )
            .await;
        } else {
            assert_eq!(
                event_response(&app, &token, target, "?after_seq=0")
                    .await
                    .status(),
                StatusCode::OK
            );
        }
        assert_eq!(
            event_response(&app, &author, target, "?after_seq=0")
                .await
                .status(),
            StatusCode::OK
        );
    }
}

#[fukulow_test::test]
async fn replay_detects_duplicate_at_page_boundary(pool: PgPool) {
    let (app, org, sender, channel, token) = fixture(&pool).await;
    sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body)
                 SELECT $1,$2,gen_random_uuid(),n,$3,gen_random_uuid(),'create' FROM generate_series(1,50) n")
        .bind(org).bind(channel).bind(sender).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO channel_message_sequences (organization_id, channel_id, seq) VALUES ($1,$2,50)")
        .bind(org).bind(channel).execute(&pool).await.unwrap();
    assert_eq!(
        event_response(&app, &token, channel, "?after_seq=0&limit=49")
            .await
            .status(),
        StatusCode::OK
    );
    sqlx::query("INSERT INTO channel_log (organization_id,channel_id,event_seq,kind,message_id,sender,operation_id,destination_topic_id)
                 SELECT $1,$2,50,'move',id,$3,gen_random_uuid(),gen_random_uuid()
                 FROM messages WHERE organization_id=$1 AND channel_id=$2 AND seq=1")
        .bind(org).bind(channel).bind(sender).execute(&pool).await.unwrap();
    let restricted = crate::test_app_pool(pool.clone()).await;
    assert!(matches!(
        replay_page(&restricted, org, channel, 0, 50).await,
        Err(sqlx::Error::RowNotFound)
    ));
    assert!(matches!(
        authorized_replay_page(&restricted, org, (sender, 0), channel, 0, 50).await,
        Err(MessageError::Database(sqlx::Error::RowNotFound))
    ));
    assert_error(
        event_response(&app, &token, channel, "?after_seq=0&limit=49").await,
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
}

#[fukulow_test::test]
async fn messages_runtime_can_mutate_state_but_cannot_erase_or_renumber_creations(pool: PgPool) {
    let (app, org, _, channel, token) = fixture(&pool).await;
    sent(&app, &token, channel, input(Uuid::new_v4(), "control")).await;
    let restricted = crate::test_app_pool(pool.clone()).await;
    for sql in [
        "DELETE FROM messages",
        "TRUNCATE messages CASCADE",
        "UPDATE messages SET organization_id=organization_id",
        "UPDATE messages SET channel_id=channel_id",
        "UPDATE messages SET seq=seq",
        "UPDATE messages SET id=id",
        "UPDATE messages SET sender=sender",
        "UPDATE messages SET client_message_id=client_message_id",
        "UPDATE messages SET send_digest=send_digest",
    ] {
        let error =
            crate::database::organization(&restricted, org, async |tx: &mut sqlx::PgConnection| {
                sqlx::query(sql).execute(tx).await
            })
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("42501"),
            "{sql}"
        );
    }
    for column in [
        "organization_id",
        "channel_id",
        "id",
        "sender",
        "client_message_id",
        "seq",
    ] {
        let value = if column == "seq" {
            "seq+1"
        } else {
            "gen_random_uuid()"
        };
        let error = sqlx::query(&format!("UPDATE messages SET {column}={value}"))
            .execute(&pool)
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("P0001"),
            "{column}"
        );
    }
    crate::database::organization(&restricted, org, async |tx: &mut sqlx::PgConnection| {
        sqlx::query(
            "UPDATE messages SET body='', deleted=true WHERE organization_id=$1 AND channel_id=$2",
        )
        .bind(org)
        .bind(channel)
        .execute(tx)
        .await
    })
    .await
    .unwrap();
    let page = replay_page(&restricted, org, channel, 0, 1).await.unwrap();
    assert!(page[0].message().deleted);
    assert!(page[0].message().body.is_none());
    assert!(page[0].message().mentions.is_none());
}
