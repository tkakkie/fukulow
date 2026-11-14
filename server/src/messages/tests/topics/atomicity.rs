use super::*;
use std::time::Duration;

async fn counts(pool: &PgPool, org: Uuid, channel: Uuid) -> (i64, i64, i64) {
    sqlx::query_as("SELECT (SELECT count(*) FROM topics WHERE organization_id=$1 AND channel_id=$2), \
        (SELECT count(*) FROM messages WHERE organization_id=$1 AND channel_id=$2), \
        COALESCE((SELECT seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2),0)")
        .bind(org).bind(channel).fetch_one(pool).await.unwrap()
}

#[fukulow_test::test]
async fn topic_admission_and_commit_rollback_leave_no_topic_sequence_count_or_publication(
    pool: PgPool,
) {
    let (_, org, sender, channel, token) = fixture(&pool).await;
    let state = AppState::for_test(pool.clone()).await;
    let delivery = state.message_delivery.clone();
    let mut queue = delivery.queue(org, (sender, 0), 256);
    queue.subscribe(channel);
    let app = crate::app(state);
    let key = Uuid::new_v4();
    let waiters = (0..CHANNEL_QUEUE_CAP)
        .map(|_| {
            delivery
                .admission(&pool)
                .reserve_send(org, channel)
                .unwrap()
        })
        .collect::<Vec<_>>();
    let rejected = send(
        &app,
        &token,
        channel,
        topic_input(key, "Created after admission"),
    )
    .await;
    assert_eq!(rejected.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        (1..=5).contains(
            &rejected.headers()[header::RETRY_AFTER]
                .to_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
        )
    );
    assert_eq!(counts(&pool, org, channel).await, (0, 0, 0));
    drop(waiters);
    let canonical = sent(
        &app,
        &token,
        channel,
        topic_input(key, "Created after admission"),
    )
    .await;
    assert_eq!(
        sent(
            &app,
            &token,
            channel,
            topic_input(key, "CREATED AFTER ADMISSION")
        )
        .await,
        canonical
    );
    delivery.flush().await;
    assert_eq!(queue.events.try_recv().unwrap().seq, 1);
    assert!(queue.events.try_recv().is_err());
    // Deferred failure runs at COMMIT, after the summary was updated.
    sqlx::query("CREATE FUNCTION reject_topic_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
        IF NEW.body = 'fail at commit' THEN RAISE EXCEPTION 'injected' USING ERRCODE='23514'; END IF; RETURN NEW; END $$")
        .execute(&pool).await.unwrap();
    sqlx::query("CREATE CONSTRAINT TRIGGER reject_topic_commit AFTER INSERT ON messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_topic_commit()")
        .execute(&pool).await.unwrap();
    let mut retries = Vec::new();
    for name in ["Empty must roll back", "Created after admission"] {
        let failed_key = Uuid::new_v4();
        let mut input = topic_input(failed_key, name);
        input["body"] = json!("fail at commit");
        retries.push(input.clone());
        assert_error(
            send(&app, &token, channel, input.clone()).await,
            StatusCode::INTERNAL_SERVER_ERROR,
        )
        .await;
        assert_eq!(counts(&pool, org, channel).await, (1, 1, 1));
        assert_eq!(
            get(&app, &token, channel, "topics").await["topics"][0]["message_count"],
            1
        );
        delivery.flush().await;
        assert!(queue.events.try_recv().is_err());
        assert!(!queue.notification_failed.is_failed());
    }
    sqlx::query("DROP TRIGGER reject_topic_commit ON messages")
        .execute(&pool)
        .await
        .unwrap();
    for (index, input) in retries.into_iter().enumerate() {
        let canonical = sent(&app, &token, channel, input.clone()).await;
        assert_eq!(canonical["seq"], index as i64 + 2);
        assert_eq!(sent(&app, &token, channel, input).await, canonical);
    }
    assert_eq!(counts(&pool, org, channel).await, (2, 3, 3));
    delivery.flush().await;
    for seq in 2..=3 {
        assert_eq!(queue.events.try_recv().unwrap().seq, seq);
    }
    assert!(queue.events.try_recv().is_err());
}

pub(crate) async fn waiting(pool: &PgPool, pid: i32) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let blocked: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM pg_locks w JOIN pg_locks h \
                USING (locktype,database,classid,objid,objsubid) WHERE h.pid=$1 AND h.granted \
                AND w.mode='ShareLock' AND NOT w.granted AND w.locktype='advisory')",
            )
            .bind(pid)
            .fetch_one(pool)
            .await
            .unwrap();
            if blocked {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[fukulow_test::test]
async fn topic_projection_ambiguous_commit_waits_before_snapshot_and_recovers_without_later_send(
    pool: PgPool,
) {
    for route in ["timeline", "topics", "summary", "history"] {
        let (app, org, _, channel, token) = fixture(&pool).await;
        let key = Uuid::new_v4();
        let pending = commit::ambiguous_commit(key);
        assert_error(
            send(&app, &token, channel, topic_input(key, "Pending")).await,
            StatusCode::INTERNAL_SERVER_ERROR,
        )
        .await;
        let mut tx = pending.await.unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(tx.connection().unwrap())
            .await
            .unwrap();
        let topic: Uuid = sqlx::query_scalar(
            "SELECT topic_id FROM messages WHERE organization_id=$1 AND client_message_id=$2",
        )
        .bind(org)
        .bind(key)
        .fetch_one(tx.connection().unwrap())
        .await
        .unwrap();
        let suffix = if route == "history" {
            format!("topics/{topic}/messages")
        } else if route == "summary" {
            format!("topics/{topic}")
        } else {
            route.into()
        };
        let read = {
            let app = app.clone();
            let token = token.clone();
            tokio::spawn(async move { get(&app, &token, channel, &suffix).await })
        };
        waiting(&pool, pid).await;
        assert!(
            !read.is_finished(),
            "projection cannot snapshot behind unresolved COMMIT"
        );
        tx.commit().await.unwrap();
        let page = read.await.unwrap();
        if route == "history" {
            let canonical = sent(&app, &token, channel, topic_input(key, "PENDING")).await;
            assert_eq!(page["messages"], json!([canonical]));
            assert_eq!(counts(&pool, org, channel).await, (1, 1, 1));
            continue;
        }
        assert_eq!(page["as_of_seq"], 1);
        let summary = match route {
            "timeline" => &page["items"][0]["topic"],
            "topics" => &page["topics"][0],
            _ => &page["topic"],
        };
        assert_eq!(summary["id"], topic.to_string());
        assert_eq!(summary["message_count"], 1);
        assert_eq!(summary["first_seq"], 1);
        assert_eq!(summary["last_seq"], 1);
        assert_eq!(
            sent(&app, &token, channel, topic_input(key, "PENDING")).await,
            summary["latest_message"]
        );
        assert_eq!(counts(&pool, org, channel).await, (1, 1, 1));
    }
}

#[fukulow_test::test]
async fn topic_projection_reauthorizes_after_waiting_for_barrier(pool: PgPool) {
    for route in ["timeline", "topics", "summary", "history"] {
        for denial in ["member", "revision", "grant"] {
            let (_, org, owner, channel, owner_token) = fixture(&pool).await;
            let viewer = Uuid::new_v4();
            let token = member(&pool, org, viewer).await;
            sqlx::query(
                "UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2",
            )
            .bind(org)
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
            for id in [owner, viewer] {
                sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)").bind(org).bind(channel).bind(id).execute(&pool).await.unwrap();
            }
            let state = AppState::for_test(pool.clone()).await;
            let app = crate::app(state);
            let message = sent(
                &app,
                &owner_token,
                channel,
                topic_input(Uuid::new_v4(), "Existing"),
            )
            .await;
            let topic = message["topic_id"].as_str().unwrap();
            let suffix = match route {
                "summary" => format!("topics/{topic}"),
                "history" => format!("topics/{topic}/messages"),
                _ => route.into(),
            };
            let mut held = pool.begin().await.unwrap();
            commit::lock(&mut held, org, channel, false).await.unwrap();
            let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
                .fetch_one(&mut *held)
                .await
                .unwrap();
            let read = {
                let app = app.clone();
                let token = token.clone();
                let suffix = suffix.clone();
                tokio::spawn(async move {
                    request(
                        &app,
                        "GET",
                        &format!("/api/v1/channels/{channel}/{suffix}"),
                        &token,
                        Value::Null,
                    )
                    .await
                })
            };
            // This read has passed its first authorization and is blocked at the barrier.
            waiting(&pool, pid).await;
            if denial == "grant" {
                sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(org).bind(channel).bind(viewer).execute(&pool).await.unwrap();
            } else {
                sqlx::query(
                    "UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2",
                )
                .bind(org)
                .bind(viewer)
                .execute(&pool)
                .await
                .unwrap();
                if denial == "revision" {
                    sqlx::query(
                        "UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2",
                    )
                    .bind(org)
                    .bind(viewer)
                    .execute(&pool)
                    .await
                    .unwrap();
                }
            }
            held.commit().await.unwrap();
            let response = read.await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::NOT_FOUND,
                "{route}: {denial}"
            );
            assert_eq!(
                body(response).await,
                json!({"error":if denial=="grant" {"channel not found"} else {"organization_unavailable"}}),
                "{route}: {denial}"
            );
            let page = get(&app, &owner_token, channel, &suffix).await;
            let latest_message = match route {
                "timeline" => &page["items"][0]["topic"]["latest_message"],
                "topics" => &page["topics"][0]["latest_message"],
                "summary" => &page["topic"]["latest_message"],
                _ => &page["messages"][0],
            };
            assert_eq!(latest_message, &message, "{route}: {denial}");
        }
    }
}

#[fukulow_test::test]
async fn topic_database_constraints_bind_organization_channel_and_preserve_null_messages(
    pool: PgPool,
) {
    let (app, org, owner, channel, token) = fixture(&pool).await;
    let plain = sent(&app, &token, channel, input(Uuid::new_v4(), "old plain")).await;
    assert!(plain["topic_id"].is_null());
    let m = sent(&app, &token, channel, topic_input(Uuid::new_v4(), "Own")).await;
    let topic: Uuid = m["topic_id"].as_str().unwrap().parse().unwrap();
    let other = Uuid::new_v4();
    super::super::channel(&pool, org, other, owner, false).await;
    let (_, foreign_org, foreign_sender, foreign_channel, _) = fixture(&pool).await;
    for (scope, ch, sender) in [
        (org, other, owner),
        (foreign_org, foreign_channel, foreign_sender),
    ] {
        let error=sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id) VALUES ($1,$2,$3,1,$4,$5,'forged',$6)")
            .bind(scope).bind(Uuid::new_v4()).bind(ch).bind(sender).bind(Uuid::new_v4()).bind(topic).execute(&pool).await.unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().constraint(),
            Some("messages_topic_channel_fk")
        );
        assert!(
            error
                .as_database_error()
                .unwrap()
                .is_foreign_key_violation()
        );
    }
    let error=sqlx::query("INSERT INTO topics (organization_id,channel_id,id,name,first_seq,last_seq,message_count) VALUES ($1,$2,$3,'forged',1,1,1)")
        .bind(foreign_org).bind(channel).bind(Uuid::new_v4()).execute(&pool).await.unwrap_err();
    assert!(
        error
            .as_database_error()
            .unwrap()
            .is_foreign_key_violation()
    );
    assert_eq!(list(&app, &token, channel, "").await["messages"][0], plain);
}

#[fukulow_test::test(migrations = false)]
async fn topic_migration_preserves_existing_messages_as_null(pool: PgPool) {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut paths = std::fs::read_dir(directory)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap().to_str().unwrap() < "202611110001_topics.sql")
        .collect::<Vec<_>>();
    paths.sort();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&pool)
            .await
            .unwrap();
    }
    let (_, org, sender, channel, token) = fixture(&pool).await;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body) VALUES ($1,$2,$3,1,$4,$5,'before Topics')")
        .bind(org).bind(id).bind(channel).bind(sender).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO channel_message_sequences VALUES ($1,$2,1)")
        .bind(org)
        .bind(channel)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/202611110001_topics.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/202611110198_replies.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    let app = router(&pool).await;
    let history = list(&app, &token, channel, "").await;
    assert_eq!(history["messages"][0]["id"], id.to_string());
    assert!(history["messages"][0]["topic_id"].is_null());
    let new = sent(
        &app,
        &token,
        channel,
        topic_input(Uuid::new_v4(), "After migration"),
    )
    .await;
    assert_eq!(new["seq"], 2);
    assert!(new["topic_id"].is_string());
}
