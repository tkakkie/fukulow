use super::*;

async fn positions(pool: &PgPool, org: Uuid, channel: Uuid) -> Vec<i64> {
    sqlx::query_scalar("SELECT event_seq FROM channel_log WHERE organization_id=$1 AND channel_id=$2 ORDER BY event_seq")
        .bind(org).bind(channel).fetch_all(pool).await.unwrap()
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
    let matching: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM channel_log l JOIN messages m ON m.organization_id=l.organization_id AND m.id=l.message_id \
         WHERE l.organization_id=$1 AND l.channel_id=$2 AND l.kind='create' AND l.event_seq=m.seq \
         AND l.channel_id=m.channel_id AND l.sender=m.sender AND l.client_message_id=m.client_message_id",
    ).bind(org).bind(channel).fetch_one(&pool).await.unwrap();
    assert_eq!(matching, 17);
}

#[fukulow_test::test]
async fn channel_log_failure_rolls_back_message_counter_and_topic(pool: PgPool) {
    let (app, org, _, channel, token) = fixture(&pool).await;
    sqlx::raw_sql(
        "CREATE FUNCTION fail_log_commit() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'injected failure after log insertion'; END $$;
         CREATE CONSTRAINT TRIGGER fail_log_commit AFTER INSERT ON channel_log
         DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_log_commit();",
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
    sqlx::query("DROP TRIGGER fail_log_commit ON channel_log")
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
        page.iter().map(|m| m.created_seq).collect::<Vec<_>>(),
        [1, 2, 3]
    );
    assert_eq!(page[1].body.as_deref(), Some("current"));
    assert_eq!(
        (page[1].seq, page[1].created_seq, page[1].version),
        (2, 2, 3)
    );
    sqlx::query("DELETE FROM messages WHERE organization_id=$1 AND channel_id=$2 AND seq=2")
        .bind(org)
        .bind(channel)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(positions(&pool, org, channel).await, [1, 2, 3]);
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
        .spawn(app_pool, (page[2].clone()).message);
    delivery.flush().await;
    assert!(queue.notification_failed.is_failed());
    assert!(queue.events.try_recv().is_err());
}

#[fukulow_test::test]
async fn channel_log_runtime_denies_update_delete_and_truncate_with_read_insert_controls(
    pool: PgPool,
) {
    let (app, org, _, channel, token) = fixture(&pool).await;
    sent(&app, &token, channel, input(Uuid::new_v4(), "control")).await;
    let app_pool = crate::test_app_pool(pool.clone()).await;
    crate::database::organization(&app_pool, org, async |tx: &mut sqlx::PgConnection| {
        assert_eq!(positions_connection(tx, org, channel).await?, [1]);
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
    assert_eq!(positions(&pool, org, channel).await, [1]);
}

async fn positions_connection(
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
    assert_eq!(positions(&pool, org, channel).await, [1, 2, 3]);
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
    seed_channel_log(&pool).await;
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
    // Orphan state cannot turn a missing event into a creation-ordered gap fill.
    sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,version,sender,client_message_id,body) VALUES ($1,gen_random_uuid(),$2,206,206,$3,gen_random_uuid(),'not logged')")
        .bind(org).bind(channel).bind(sender).execute(&pool).await.unwrap();
    let page = body(event_response(&app, &token, channel, "?after_seq=205").await).await;
    assert_eq!(page, json!({"events":[],"has_more":false}));
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
    // The owner-only fault injection bypasses append-only triggers for corrupt-log probes.
    sqlx::query("ALTER TABLE channel_log DISABLE TRIGGER USER")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "DELETE FROM channel_log WHERE organization_id=$1 AND channel_id=$2 AND event_seq=2",
    )
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
