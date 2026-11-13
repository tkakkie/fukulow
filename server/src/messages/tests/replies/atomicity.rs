use super::*;

#[sqlx::test]
async fn reply_admission_and_commit_rollback_preserve_seq_topic_count_and_publication(
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
        topics::topic_input(Uuid::new_v4(), "Release"),
    )
    .await;
    delivery.flush().await;
    let mut queue = delivery.queue(org, (sender, 0), 256);
    queue.subscribe(channel);
    let intent = reply_input(Uuid::new_v4(), &root);
    let waiters = (0..CHANNEL_QUEUE_CAP)
        .map(|_| {
            delivery
                .admission(&pool)
                .reserve_send(org, channel)
                .unwrap()
        })
        .collect::<Vec<_>>();
    let rejected = send(&app, &token, channel, intent.clone()).await;
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
    assert_eq!(counts(&pool, org, channel).await, (1, 1, 1));
    drop(waiters);
    sqlx::query("CREATE FUNCTION reject_reply_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reply_to_id IS NOT NULL THEN RAISE EXCEPTION 'injected' USING ERRCODE='23514'; END IF; RETURN NEW; END $$").execute(&pool).await.unwrap();
    sqlx::query("CREATE CONSTRAINT TRIGGER reject_reply_commit AFTER INSERT ON messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_reply_commit()").execute(&pool).await.unwrap();
    assert_error(
        send(&app, &token, channel, intent.clone()).await,
        StatusCode::INTERNAL_SERVER_ERROR,
    )
    .await;
    assert_eq!(counts(&pool, org, channel).await, (1, 1, 1));
    delivery.flush().await;
    assert!(queue.events.try_recv().is_err());
    assert!(!queue.notification_failed.is_failed());
    sqlx::query("DROP TRIGGER reject_reply_commit ON messages")
        .execute(&pool)
        .await
        .unwrap();
    let canonical = sent(&app, &token, channel, intent.clone()).await;
    assert_eq!(canonical["seq"], 2);
    assert_eq!(sent(&app, &token, channel, intent).await, canonical);
    assert_eq!(counts(&pool, org, channel).await, (2, 2, 2));
    delivery.flush().await;
    assert_eq!(queue.events.try_recv().unwrap().id, id(&canonical));
    assert!(queue.events.try_recv().is_err());
}

#[sqlx::test]
async fn reply_parent_commit_and_rollback_races_require_a_committed_parent(pool: PgPool) {
    for commit_parent in [true, false] {
        let (app, org, sender, channel, token) = fixture(&pool).await;
        let parent_id = Uuid::new_v4();
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("INSERT INTO channel_message_sequences VALUES ($1,$2,1)")
            .bind(org)
            .bind(channel)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body) VALUES ($1,$2,$3,1,$4,$5,'Pending parent')")
            .bind(org).bind(channel).bind(parent_id).bind(sender).bind(Uuid::new_v4()).execute(&mut *tx).await.unwrap();
        let intent =
            json!({"client_message_id":Uuid::new_v4(),"body":"Reply payload","reply_to":parent_id});
        error(
            tokio::time::timeout(
                Duration::from_secs(2),
                send(&app, &token, channel, intent.clone()),
            )
            .await
            .unwrap(),
            StatusCode::NOT_FOUND,
            "reply_parent_not_found",
        )
        .await;
        assert_eq!(counts(&pool, org, channel).await, (0, 0, 0));
        if commit_parent {
            tx.commit().await.unwrap();
            let reply = sent(&app, &token, channel, intent.clone()).await;
            assert_eq!(reply["seq"], 2);
            assert_eq!(reply["reply_root_id"], parent_id.to_string());
            assert_eq!(sent(&app, &token, channel, intent).await, reply);
        } else {
            tx.rollback().await.unwrap();
            error(
                send(&app, &token, channel, intent).await,
                StatusCode::NOT_FOUND,
                "reply_parent_not_found",
            )
            .await;
            let next = sent(
                &app,
                &token,
                channel,
                input(Uuid::new_v4(), "After rollback"),
            )
            .await;
            assert_eq!(next["seq"], 1);
        }
    }
}

#[sqlx::test]
async fn reply_chain_ambiguous_commit_waits_and_same_key_recovers_without_later_send(pool: PgPool) {
    for committed in [true, false] {
        let (app, org, _, channel, token) = fixture(&pool).await;
        let root = sent(
            &app,
            &token,
            channel,
            topics::topic_input(Uuid::new_v4(), "Release"),
        )
        .await;
        let key = Uuid::new_v4();
        let pending = commit::ambiguous_commit(key);
        let intent = reply_input(key, &root);
        assert_error(
            send(&app, &token, channel, intent.clone()).await,
            StatusCode::INTERNAL_SERVER_ERROR,
        )
        .await;
        let mut tx = pending.await.unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(tx.connection().unwrap())
            .await
            .unwrap();
        let reading = {
            let (app, token, root) = (app.clone(), token.clone(), root.clone());
            tokio::spawn(async move { page(&app, &token, channel, id(&root), "").await })
        };
        super::super::topics::atomicity::waiting(&pool, pid).await;
        assert!(!reading.is_finished());
        if committed {
            tx.commit().await.unwrap();
        } else {
            tx.rollback().await.unwrap();
        }
        let p = reading.await.unwrap();
        assert_eq!(
            p["messages"].as_array().unwrap().len(),
            if committed { 2 } else { 1 }
        );
        assert_eq!(
            counts(&pool, org, channel).await,
            if committed { (2, 2, 2) } else { (1, 1, 1) }
        );
        let recovered = sent(&app, &token, channel, intent.clone()).await;
        assert_eq!(recovered["seq"], 2);
        if committed {
            assert_eq!(p["messages"][1], recovered);
        }
        assert_eq!(sent(&app, &token, channel, intent).await, recovered);
        assert_eq!(counts(&pool, org, channel).await, (2, 2, 2));
    }
}

#[sqlx::test(migrations = false)]
async fn reply_migration_preserves_existing_rows_and_scopes_both_foreign_keys(pool: PgPool) {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut paths = std::fs::read_dir(directory)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap().to_str().unwrap() < "202611110198_replies.sql")
        .collect::<Vec<_>>();
    paths.sort();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&pool)
            .await
            .unwrap();
    }
    let (_, org, sender, channel, token) = fixture(&pool).await;
    let root_id = Uuid::new_v4();
    sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body) VALUES ($1,$2,$3,1,$4,$5,'Before Replies')")
        .bind(org).bind(channel).bind(root_id).bind(sender).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO channel_message_sequences VALUES ($1,$2,1)")
        .bind(org)
        .bind(channel)
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
    let root = list(&app, &token, channel, "").await["messages"][0].clone();
    assert_eq!(root["id"], root_id.to_string());
    assert!(root["reply_to"].is_null() && root["reply_root_id"].is_null());
    let child = sent(&app, &token, channel, reply_input(Uuid::new_v4(), &root)).await;
    let other = Uuid::new_v4();
    super::super::channel(&pool, org, other, sender, false).await;
    let (_, foreign_org, foreign_sender, foreign_channel, _) = fixture(&pool).await;
    for (scope, ch, who) in [
        (org, other, sender),
        (foreign_org, foreign_channel, foreign_sender),
    ] {
        let local = Uuid::new_v4();
        sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body) VALUES ($1,$2,$3,1,$4,$5,'Local')").bind(scope).bind(ch).bind(local).bind(who).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
        for (parent, root, constraint) in [
            (root_id, local, "messages_reply_parent_channel_fk"),
            (local, root_id, "messages_reply_root_channel_fk"),
        ] {
            let e=sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body,reply_to_id,reply_root_id) VALUES ($1,$2,$3,2,$4,$5,'Forged',$6,$7)")
                .bind(scope).bind(ch).bind(Uuid::new_v4()).bind(who).bind(Uuid::new_v4()).bind(parent).bind(root).execute(&pool).await.unwrap_err();
            assert_eq!(
                e.as_database_error().unwrap().constraint(),
                Some(constraint)
            );
        }
    }
    let e = sqlx::query("UPDATE messages SET reply_to_id=id WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(id(&child))
        .execute(&pool)
        .await
        .unwrap_err();
    assert_eq!(
        e.as_database_error().unwrap().constraint(),
        Some("messages_reply_not_self")
    );
    let e =
        sqlx::query("UPDATE messages SET reply_root_id=NULL WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(id(&child))
            .execute(&pool)
            .await
            .unwrap_err();
    assert_eq!(
        e.as_database_error().unwrap().constraint(),
        Some("messages_reply_pair")
    );
}

#[sqlx::test]
async fn reply_chain_reauthorizes_member_revision_and_grant_after_barrier_wait(pool: PgPool) {
    for loss in ["member", "revision", "grant"] {
        let (_, org, owner, channel, owner_token) = fixture(&pool).await;
        let viewer = Uuid::new_v4();
        let token = member(&pool, org, viewer).await;
        sqlx::query("UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
        for who in [owner, viewer] {
            sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)").bind(org).bind(channel).bind(who).execute(&pool).await.unwrap();
        }
        let state = AppState::for_test(pool.clone()).await;
        let app = crate::app(state);
        let root = sent(&app, &owner_token, channel, input(Uuid::new_v4(), "Root")).await;
        let child = sent(&app, &token, channel, reply_input(Uuid::new_v4(), &root)).await;
        page(&app, &token, channel, id(&child), "").await;
        let mut held = pool.begin().await.unwrap();
        commit::lock(&mut held, org, channel, false).await.unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *held)
            .await
            .unwrap();
        let read = {
            let (app, token, child) = (app.clone(), token.clone(), child.clone());
            tokio::spawn(async move { chain(&app, &token, channel, id(&child), "").await })
        };
        super::super::topics::atomicity::waiting(&pool, pid).await;
        if loss == "grant" {
            sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(org).bind(channel).bind(viewer).execute(&pool).await.unwrap();
        } else {
            sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(viewer)
                .execute(&pool)
                .await
                .unwrap();
            if loss == "revision" {
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
        error(
            read.await.unwrap(),
            StatusCode::NOT_FOUND,
            if loss == "grant" {
                "channel not found"
            } else {
                "organization_unavailable"
            },
        )
        .await;
        assert_eq!(
            page(&app, &owner_token, channel, id(&child), "").await["messages"],
            json!([root, child])
        );
    }
}
