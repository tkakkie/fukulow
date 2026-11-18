use super::*;

#[fukulow_test::test]
async fn reply_counts_bound_anchors_and_descendants_by_watermark_in_data_snapshot(pool: PgPool) {
    let (app, org, sender, channel, token) = fixture(&pool).await;
    let root = sent(&app, &token, channel, input(Uuid::new_v4(), "Root")).await;
    let child = sent(&app, &token, channel, reply_input(Uuid::new_v4(), &root)).await;
    let future = Uuid::new_v4();
    let ids = vec![id(&root), id(&child), future];
    let gate = Arc::new(Gate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    GATES.lock().unwrap().insert(channel, gate.clone());
    let read = {
        let (app, token, ids) = (app.clone(), token.clone(), ids.clone());
        tokio::spawn(async move { page(&app, &token, channel, &ids).await })
    };
    tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let late = sent(&app, &token, channel, reply_input(Uuid::new_v4(), &child)).await;
    assert_eq!(late["created_seq"], 3);
    sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body,reply_to_id,reply_root_id) VALUES ($1,$2,$3,4,$4,gen_random_uuid(),'Future Reply',$5,$6)")
        .bind(org).bind(channel).bind(future).bind(sender).bind(id(&child)).bind(id(&root)).execute(&pool).await.unwrap();
    sqlx::query(
        "UPDATE channel_message_sequences SET seq=4 WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(org)
    .bind(channel)
    .execute(&pool)
    .await
    .unwrap();
    seed_channel_log(&pool).await;
    gate.release.add_permits(1);
    let result = read.await.unwrap();
    assert_eq!(result["as_of_seq"], 2);
    assert_eq!(result["counts"].as_array().unwrap().len(), 2);
    for e in result["counts"].as_array().unwrap() {
        assert_eq!(e["reply_count"], 1);
    }
    let fresh = page(&app, &token, channel, &ids).await;
    assert_eq!(fresh["as_of_seq"], 4);
    assert_eq!(fresh["counts"].as_array().unwrap().len(), 3);
    for e in fresh["counts"].as_array().unwrap() {
        assert_eq!(e["reply_count"], 3);
    }
}

#[fukulow_test::test]
async fn reply_counts_reauthorize_member_revision_and_grant_after_barrier_wait(pool: PgPool) {
    for loss in ["member", "revision", "grant"] {
        let (app, org, sender, channel, author) = fixture(&pool).await;
        let actor = Uuid::new_v4();
        let token = member(&pool, org, actor).await;
        sqlx::query("UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
        for who in [sender, actor] {
            grant(&pool, org, channel, who).await;
        }
        let root = sent(&app, &author, channel, input(Uuid::new_v4(), "Root")).await;
        sent(&app, &author, channel, reply_input(Uuid::new_v4(), &root)).await;
        assert_eq!(
            page(&app, &token, channel, &[id(&root)]).await["counts"],
            json!([entry(id(&root), id(&root), 1)])
        );
        let mut held = pool.begin().await.unwrap();
        commit::lock(&mut held, org, channel, false).await.unwrap();
        let pid = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *held)
            .await
            .unwrap();
        let read = {
            let (app, token) = (app.clone(), token.clone());
            let root = id(&root);
            tokio::spawn(async move { query(&app, &token, channel, &[root]).await })
        };
        crate::messages::tests::topics::atomicity::waiting(&pool, pid).await;
        if loss == "grant" {
            revoke(&pool, org, channel, actor).await;
        } else {
            sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(actor)
                .execute(&pool)
                .await
                .unwrap();
            if loss == "revision" {
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
            page(&app, &author, channel, &[id(&root)]).await["counts"],
            json!([entry(id(&root), id(&root), 1)])
        );
    }
}

#[fukulow_test::test]
async fn reply_counts_wait_out_ambiguous_commit_and_preserve_rollback_baseline(pool: PgPool) {
    for committed in [true, false] {
        let (app, _, _, channel, token) = fixture(&pool).await;
        let root = sent(&app, &token, channel, input(Uuid::new_v4(), "Root")).await;
        let key = Uuid::new_v4();
        let pending = commit::ambiguous_commit(key);
        assert_error(
            send(&app, &token, channel, reply_input(key, &root)).await,
            StatusCode::INTERNAL_SERVER_ERROR,
        )
        .await;
        let mut tx = pending.await.unwrap();
        let pid = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(tx.connection().unwrap())
            .await
            .unwrap();
        let read = {
            let (app, token) = (app.clone(), token.clone());
            let root = id(&root);
            tokio::spawn(async move { page(&app, &token, channel, &[root]).await })
        };
        crate::messages::tests::topics::atomicity::waiting(&pool, pid).await;
        assert!(!read.is_finished());
        if committed {
            tx.commit().await.unwrap();
        } else {
            tx.rollback().await.unwrap();
        }
        let result = read.await.unwrap();
        assert_eq!(
            result,
            json!({"as_of_seq":if committed {2} else {1},"counts":[entry(id(&root),id(&root),if committed {1} else {0})]})
        );
    }
}
