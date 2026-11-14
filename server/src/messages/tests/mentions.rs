use super::*;

mod counts;
mod denials;
mod ordering;
mod plans;

#[fukulow_test::test(migrations = false)]
async fn mention_migration_has_no_backfill_and_enforces_scoped_keys_and_cascade(pool: PgPool) {
    let mut paths =
        std::fs::read_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name().unwrap().to_str().unwrap() < "202611140300_message_mentions.sql"
            })
            .collect::<Vec<_>>();
    paths.sort();
    for p in paths {
        sqlx::raw_sql(&std::fs::read_to_string(p).unwrap())
            .execute(&pool)
            .await
            .unwrap();
    }
    let (app, org, sender, channel, author) = fixture(&pool).await;
    let target = Uuid::new_v4();
    let viewer = member(&pool, org, target).await;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body) VALUES ($1,$2,$3,1,$4,gen_random_uuid(),$5)")
        .bind(org).bind(channel).bind(id).bind(sender).bind(token(target)).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO channel_message_sequences VALUES ($1,$2,1)")
        .bind(org)
        .bind(channel)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../migrations/202611140300_message_mentions.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(mention_rows(&pool, org).await, 0);
    assert_eq!(
        list(&app, &author, channel, "").await["messages"][0]["mentions"],
        json!([])
    );
    let c = counts(&app, &viewer).await;
    assert_eq!(c["channels"][0]["unread_count"], 1);
    assert_eq!(c["channels"][0]["mention_unread_count"], 0);
    let foreign_org = organization(&pool).await;
    let foreign = Uuid::new_v4();
    member(&pool, foreign_org, foreign).await;
    let insert = "INSERT INTO message_mentions (organization_id,channel_id,message_id,member_id) VALUES ($1,$2,$3,$4)";
    for (o, c, m, who) in [
        (org, channel, id, foreign),
        (org, Uuid::new_v4(), id, target),
        (foreign_org, channel, id, foreign),
        (org, channel, Uuid::new_v4(), target),
    ] {
        let e = sqlx::query(insert)
            .bind(o)
            .bind(c)
            .bind(m)
            .bind(who)
            .execute(&pool)
            .await
            .unwrap_err();
        assert_eq!(
            e.as_database_error().unwrap().code().as_deref(),
            Some("23503")
        );
    }
    sqlx::query(insert)
        .bind(org)
        .bind(channel)
        .bind(id)
        .bind(target)
        .execute(&pool)
        .await
        .unwrap();
    let e = sqlx::query(insert)
        .bind(org)
        .bind(channel)
        .bind(id)
        .bind(target)
        .execute(&pool)
        .await
        .unwrap_err();
    assert_eq!(
        e.as_database_error().unwrap().code().as_deref(),
        Some("23505")
    );
    sqlx::query("DELETE FROM messages WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(mention_rows(&pool, org).await, 0);
}

fn token(id: Uuid) -> String {
    format!("@{{member:{id}}}")
}

async fn grant(pool: &PgPool, org: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3) ON CONFLICT (organization_id,channel_id,member_id) DO UPDATE SET membership_revision=(SELECT membership_revision FROM users WHERE organization_id=$1 AND id=$3)")
        .bind(org).bind(channel).bind(member).execute(pool).await.unwrap();
}

async fn mention_rows(pool: &PgPool, org: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM message_mentions WHERE organization_id=$1")
        .bind(org)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn counts(app: &Router, token: &str) -> Value {
    let response = request(app, "GET", "/api/v1/channels", token, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    body(response).await
}

async fn projection(app: &Router, token: &str, channel: Uuid, suffix: &str) -> Value {
    let response = request(
        app,
        "GET",
        &format!("/api/v1/channels/{channel}/{suffix}"),
        token,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    body(response).await
}

#[test]
fn mention_exact_syntax_deduplicates_sorts_and_preserves_plain_text() {
    let a = Uuid::from_u128(0xa);
    let b = Uuid::from_u128(0xb);
    let valid = format!(
        "先{0}{1}word`{0}`\\{0} @all @channel @Member",
        token(b),
        token(a)
    );
    assert_eq!(super::super::mentions::extract(&valid), vec![a, b]);
    for text in [
        token(a).to_uppercase(),
        token(a).replace("000a", "000A"),
        token(a).replace("member:", "member: "),
        token(a).replace('-', ""),
        format!("@{{member:{a}"),
        format!("@{{member:{{{a}}}}}"),
        "@all @channel @Member @{member:} @{member:🦉}".into(),
        format!("@{{member:{a}0}}"),
        format!("@{{member:{} }}", a),
    ] {
        assert!(super::super::mentions::extract(&text).is_empty(), "{text}");
    }
    assert_eq!(
        super::super::mentions::extract(&format!("@{{member:bad {}", token(a))),
        vec![a]
    );
}

#[fukulow_test::test]
async fn mention_shared_surfaces_keep_sets_and_follow_non_author_rename(pool: PgPool) {
    let (app, org, sender, channel, author) = fixture(&pool).await;
    let target = Uuid::new_v4();
    member(&pool, org, target).await;
    let body_text = format!("{}{} {}", token(target), token(sender), token(target));
    let plain = sent(&app, &author, channel, input(Uuid::new_v4(), &body_text)).await;
    let topic = sent(
        &app,
        &author,
        channel,
        json!({"client_message_id":Uuid::new_v4(),"body":body_text,"topic_name":"Mentions"}),
    )
    .await;
    let reply = sent(
        &app,
        &author,
        channel,
        json!({"client_message_id":Uuid::new_v4(),"body":body_text,"reply_to":topic["id"]}),
    )
    .await;
    let main_reply = sent(
        &app,
        &author,
        channel,
        json!({"client_message_id":Uuid::new_v4(),"body":body_text,"reply_to":plain["id"]}),
    )
    .await;
    let mut ids = [sender, target];
    ids.sort();
    for message in [&plain, &topic, &reply, &main_reply] {
        assert_eq!(message["body"], body_text);
        assert_eq!(
            message["mentions"],
            json!(
                ids.iter()
                    .map(|id| json!({"member_id":id,"name":"Member"}))
                    .collect::<Vec<_>>()
            )
        );
    }
    let empty = sent(
        &app,
        &author,
        channel,
        input(Uuid::new_v4(), "@all @{member:invalid}"),
    )
    .await;
    assert_eq!(empty["mentions"], json!([]));
    // Target never authored a Message; retained identity also follows rename
    // after deactivation, without revalidating the accepted set.
    sqlx::query("UPDATE users SET name='Renamed',deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2")
        .bind(org).bind(target).execute(&pool).await.unwrap();
    let check = |message: &Value| {
        assert_eq!(message["mentions"].as_array().unwrap().len(), 2);
        assert_eq!(
            message["mentions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["member_id"] == target.to_string())
                .unwrap()["name"],
            "Renamed"
        );
        assert_eq!(message["body"], body_text);
    };
    let retry = sent(
        &app,
        &author,
        channel,
        input(
            Uuid::parse_str(plain["client_message_id"].as_str().unwrap()).unwrap(),
            &body_text,
        ),
    )
    .await;
    check(&retry);
    let history = list(&app, &author, channel, "?after_seq=0").await;
    for m in history["messages"].as_array().unwrap().iter().take(4) {
        check(m);
    }
    let topic_id = topic["topic_id"].as_str().unwrap();
    let filtered = projection(
        &app,
        &author,
        channel,
        &format!("topics/{topic_id}/messages"),
    )
    .await;
    for m in filtered["messages"].as_array().unwrap() {
        check(m);
    }
    let timeline = projection(&app, &author, channel, "timeline").await;
    for item in timeline["items"].as_array().unwrap() {
        if item["kind"] == "topic" {
            check(&item["topic"]["latest_message"]);
        } else if item["message"]["id"] != empty["id"] {
            check(&item["message"]);
        }
    }
    for suffix in ["topics".into(), format!("topics/{topic_id}")] {
        let value = projection(&app, &author, channel, &suffix).await;
        if suffix == "topics" {
            check(&value["topics"][0]["latest_message"]);
        } else {
            check(&value["topic"]["latest_message"]);
        }
    }
    for root in [&plain, &topic] {
        let chain = projection(
            &app,
            &author,
            channel,
            &format!("messages/{}/chain", root["id"].as_str().unwrap()),
        )
        .await;
        for m in chain["messages"].as_array().unwrap() {
            check(m);
        }
    }
    let app_pool = crate::test_app_pool(pool.clone()).await;
    let replay = authorized_replay_page(&app_pool, org, (sender, 0), channel, 0, 5)
        .await
        .unwrap();
    for m in replay.iter().take(4) {
        check(&serde_json::to_value(m).unwrap());
    }
}

#[fukulow_test::test]
async fn mention_canonical_duplicate_rollback_and_uncertain_commit_are_atomic(pool: PgPool) {
    let (app, org, sender, channel, author) = fixture(&pool).await;
    let target = Uuid::new_v4();
    member(&pool, org, target).await;
    let text = token(target);
    let key = Uuid::new_v4();
    let (a, b) = tokio::join!(
        sent(&app, &author, channel, input(key, &text)),
        sent(&app, &author, channel, input(key, &text))
    );
    assert_eq!(a, b);
    assert_eq!(a["seq"], 1);
    assert_eq!(mention_rows(&pool, org).await, 1);
    for changed in [
        input(key, &format!("{text} changed")),
        json!({"client_message_id":key,"body":text,"topic_name":"changed"}),
        json!({"client_message_id":key,"body":text,"reply_to":a["id"]}),
    ] {
        assert_eq!(
            send(&app, &author, channel, changed).await.status(),
            StatusCode::CONFLICT
        );
    }
    // Fail after Mention insertion, at the deferred commit constraint trigger.
    sqlx::raw_sql("CREATE FUNCTION reject_mention_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rollback' USING ERRCODE='23514'; END $$; CREATE CONSTRAINT TRIGGER reject_mention_commit AFTER INSERT ON message_mentions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_mention_commit()")
        .execute(&pool).await.unwrap();
    let failed = send(
        &app,
        &author,
        channel,
        json!({"client_message_id":Uuid::new_v4(),"body":text,"topic_name":"Rollback"}),
    )
    .await;
    assert_eq!(failed.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(mention_rows(&pool, org).await, 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM messages WHERE organization_id=$1")
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM topics WHERE organization_id=$1")
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    sqlx::query("DROP TRIGGER reject_mention_commit ON message_mentions")
        .execute(&pool)
        .await
        .unwrap();
    let state = AppState::for_test(pool.clone()).await;
    let app = crate::app(state.clone());
    let key = Uuid::new_v4();
    let pending = ambiguous_commit(key);
    assert_eq!(
        send(&app, &author, channel, input(key, &text))
            .await
            .status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    pending.await.unwrap().commit().await.unwrap();
    let retried = sent(&app, &author, channel, input(key, &text)).await;
    assert_eq!(retried["seq"], 2);
    assert_eq!(retried["mentions"], a["mentions"]);
    assert_eq!(mention_rows(&pool, org).await, 2);
    // A separate in-process limiter cannot coalesce these duplicate sends;
    // exercise the database unique-key loser across different Channels.
    let other = Uuid::new_v4();
    super::channel(&pool, org, other, sender, false).await;
    let app2 = router(&pool).await;
    let key = Uuid::new_v4();
    // Both transactions must allocate and reach INSERT before either can win.
    // The trigger blocks before unique-key arbitration, independently per Channel.
    let mut gate = pool.acquire().await.unwrap();
    sqlx::query("SELECT pg_advisory_lock(152,391)")
        .execute(&mut *gate)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE FUNCTION gate_duplicate_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(152,391); RETURN NEW; END $$; CREATE TRIGGER gate_duplicate_insert BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION gate_duplicate_insert()")
        .execute(&pool).await.unwrap();
    let sends = tokio::spawn(async move {
        tokio::join!(
            send(&app, &author, channel, input(key, &text)),
            send(&app2, &author, other, input(key, &text))
        )
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let waiting: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=152 AND objid=391 AND NOT granted")
                .fetch_one(&pool).await.unwrap();
            if waiting == 2 { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    sqlx::query("SELECT pg_advisory_unlock(152,391)")
        .execute(&mut *gate)
        .await
        .unwrap();
    let (a, b) = sends.await.unwrap();
    assert_eq!(
        [a.status(), b.status()]
            .into_iter()
            .filter(|s| *s == StatusCode::CREATED)
            .count(),
        1
    );
    assert_eq!(
        [a.status(), b.status()]
            .into_iter()
            .filter(|s| *s == StatusCode::CONFLICT)
            .count(),
        1
    );
    assert_eq!(mention_rows(&pool, org).await, 3);
    let (winner, loser, winner_seq, loser_seq) = if a.status() == StatusCode::CREATED {
        (channel, other, 3, 0)
    } else {
        (other, channel, 1, 2)
    };
    for (id, expected) in [(winner, winner_seq), (loser, loser_seq)] {
        let allocated: i64 = sqlx::query_scalar("SELECT COALESCE((SELECT seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2),0)")
            .bind(org).bind(id).fetch_one(&pool).await.unwrap();
        assert_eq!(
            allocated, expected,
            "unique-key loser must roll back its allocation"
        );
    }
    let persisted: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM messages WHERE organization_id=$1 AND client_message_id=$2",
    )
    .bind(org)
    .bind(key)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(persisted, 1);
}
