use super::*;
use std::time::Duration;

async fn waiting(pool: &PgPool) {
    tokio::time::timeout(Duration::from_secs(3),async {
        loop {
            let blocked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid())").fetch_one(pool).await.unwrap();
            if blocked {break;} tokio::task::yield_now().await;
        }
    }).await.unwrap();
}

async fn loss(app: &Router, author: &str, channel: Uuid, target: Uuid, deactivate: bool) {
    let (method, path) = if deactivate {
        (
            "POST",
            format!(
                "/api/v1/orgs/{}/members/{target}/deactivate",
                author.split_once('.').unwrap().0
            ),
        )
    } else {
        (
            "DELETE",
            format!("/api/v1/channels/{channel}/members/{target}"),
        )
    };
    let response = request(app, method, &path, author, Value::Null).await;
    assert_eq!(
        response.status(),
        StatusCode::NO_CONTENT,
        "loss request failed"
    );
}

#[fukulow_test::test]
async fn mention_send_before_revoke_or_deactivate_holds_authority_through_commit(pool: PgPool) {
    for deactivate in [false, true] {
        let (_, org, sender, channel, author) = fixture(&pool).await;
        sqlx::query("UPDATE users SET role='owner' WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(sender)
            .execute(&pool)
            .await
            .unwrap();
        let target = Uuid::new_v4();
        let viewer = member(&pool, org, target).await;
        grant(&pool, org, channel, sender).await;
        grant(&pool, org, channel, target).await;
        sqlx::query("UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
        let state = AppState::for_test(pool.clone()).await;
        let app = crate::app(state.clone());
        let key = Uuid::new_v4();
        let gate = pause_commit(key);
        let text = token(target);
        let work_app = app.clone();
        let work_author = author.clone();
        let work_text = text.clone();
        let sending = tokio::spawn(async move {
            sent(&work_app, &work_author, channel, input(key, &work_text)).await
        });
        tokio::time::timeout(Duration::from_secs(3), gate.entered.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        // These locks, independent of the #135 barrier, prove the Member and
        // grant authority itself is retained until COMMIT.
        for sql in [
            "SELECT id FROM users WHERE organization_id=$1 AND id=$3 AND $2::uuid IS NOT NULL FOR NO KEY UPDATE NOWAIT",
            "SELECT member_id FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 FOR UPDATE NOWAIT",
        ] {
            let mut tx = pool.begin().await.unwrap();
            let error = sqlx::query(sql)
                .bind(org)
                .bind(channel)
                .bind(target)
                .fetch_all(&mut *tx)
                .await
                .unwrap_err();
            assert_eq!(
                error.as_database_error().unwrap().code().as_deref(),
                Some("55P03")
            );
            tx.rollback().await.unwrap();
        }
        let work_app = app.clone();
        let work_author = author.clone();
        let losing = tokio::spawn(async move {
            loss(&work_app, &work_author, channel, target, deactivate).await
        });
        waiting(&pool).await;
        assert!(!losing.is_finished());
        gate.release.add_permits(1);
        let accepted = sending.await.unwrap();
        losing.await.unwrap();
        assert_eq!(
            accepted["mentions"],
            json!([{"member_id":target,"name":"Member"}])
        );
        assert_eq!(mention_rows(&pool, org).await, 1);
        // Target loss does not change canonical identity, even after a rename.
        sqlx::query("UPDATE users SET name='Retained' WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(target)
            .execute(&pool)
            .await
            .unwrap();
        let retried = sent(&app, &author, channel, input(key, &text)).await;
        assert_eq!(retried["id"], accepted["id"]);
        assert_eq!(
            retried["mentions"],
            json!([{"member_id":target,"name":"Retained"}])
        );
        if !deactivate {
            assert!(
                counts(&app, &viewer).await["channels"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
        }
        let later = send(&app, &author, channel, input(Uuid::new_v4(), &text)).await;
        assert_eq!(later.status(), StatusCode::CREATED);
        assert_eq!(body(later).await["mentions"], json!([]));
        if deactivate {
            sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(target)
                .execute(&pool)
                .await
                .unwrap();
        }
        grant(&pool, org, channel, target).await;
        let current_viewer = if deactivate {
            member_session(&pool, org, target).await
        } else {
            viewer
        };
        assert_eq!(
            counts(&app, &current_viewer).await["channels"][0]["mention_unread_count"],
            0
        );
        // Sender access is independently reauthorized on canonical retry.
        sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(org).bind(channel).bind(sender).execute(&pool).await.unwrap();
        assert_eq!(
            send(&app, &author, channel, input(key, &text))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
}

async fn member_session(pool: &PgPool, org: Uuid, id: Uuid) -> String {
    let token = format!("{org}.{}", Uuid::new_v4());
    sqlx::query("INSERT INTO account_sessions (token_hash,account_id) SELECT $3,account_id FROM users WHERE organization_id=$1 AND id=$2").bind(org).bind(id).bind(Sha256::digest(token.as_bytes()).to_vec()).execute(pool).await.unwrap();
    token
}

#[fukulow_test::test]
async fn mention_revoke_or_deactivate_before_acceptance_is_silently_omitted(pool: PgPool) {
    for deactivate in [false, true] {
        let (_, org, sender, channel, author) = fixture(&pool).await;
        sqlx::query("UPDATE users SET role='owner' WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(sender)
            .execute(&pool)
            .await
            .unwrap();
        let target = Uuid::new_v4();
        member(&pool, org, target).await;
        let control = Uuid::new_v4();
        member(&pool, org, control).await;
        for id in [sender, target, control] {
            grant(&pool, org, channel, id).await;
        }
        sqlx::query("UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
        let app = router(&pool).await;
        loss(&app, &author, channel, target, deactivate).await;
        let text = format!("{}{}", token(target), token(control));
        let key = Uuid::new_v4();
        let message = sent(&app, &author, channel, input(key, &text)).await;
        assert_eq!(
            message["mentions"],
            json!([{"member_id":control,"name":"Member"}])
        );
        if deactivate {
            sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(target)
                .execute(&pool)
                .await
                .unwrap();
        }
        grant(&pool, org, channel, target).await;
        assert_eq!(
            sent(&app, &author, channel, input(key, &text)).await,
            message
        );
        assert_eq!(mention_rows(&pool, org).await, 1);
    }
}

#[fukulow_test::test]
async fn mention_reciprocal_reversed_targets_and_database_duplicates_do_not_deadlock(pool: PgPool) {
    let (app, org, sender, channel, author) = fixture(&pool).await;
    let target = Uuid::new_v4();
    let other = member(&pool, org, target).await;
    let third = Uuid::new_v4();
    member(&pool, org, third).await;
    let a = format!("{}{}{}", token(sender), token(target), token(third));
    let b = format!("{}{}{}", token(third), token(target), token(sender));
    let (a, b) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(
            sent(&app, &author, channel, input(Uuid::new_v4(), &a)),
            sent(&app, &other, channel, input(Uuid::new_v4(), &b))
        )
    })
    .await
    .unwrap();
    assert_eq!(a["mentions"], b["mentions"]);
    assert_eq!(mention_rows(&pool, org).await, 6);
    let app2 = router(&pool).await;
    let key = Uuid::new_v4();
    let text = token(target);
    let (a, b) = tokio::join!(
        sent(&app, &author, channel, input(key, &text)),
        sent(&app2, &author, channel, input(key, &text))
    );
    assert_eq!(a, b);
    assert_eq!(a["seq"], 3);
    assert_eq!(mention_rows(&pool, org).await, 7);
}

#[fukulow_test::test]
async fn mention_waiting_acceptance_rechecks_committed_role_revision_revocation_and_activity(
    pool: PgPool,
) {
    for change in ["revoke", "deactivate", "role", "revision"] {
        let (app, org, sender, channel, author) = fixture(&pool).await;
        let target = Uuid::new_v4();
        member(&pool, org, target).await;
        let good = Uuid::new_v4();
        member(&pool, org, good).await;
        if change != "role" {
            for id in [sender, target, good] {
                grant(&pool, org, channel, id).await;
            }
            sqlx::query(
                "UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2",
            )
            .bind(org)
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
        }
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM users WHERE organization_id=$1 AND id=$2 FOR NO KEY UPDATE")
            .bind(org)
            .bind(target)
            .execute(&mut *tx)
            .await
            .unwrap();
        match change {
            "revoke" => {
                sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(org).bind(channel).bind(target).execute(&mut *tx).await.unwrap();
            }
            "role" => {
                sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
                    .bind(org)
                    .bind(target)
                    .execute(&mut *tx)
                    .await
                    .unwrap();
            }
            _ => {
                sqlx::query("UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2").bind(org).bind(target).execute(&mut *tx).await.unwrap();
                if change == "revision" {
                    sqlx::query(
                        "UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2",
                    )
                    .bind(org)
                    .bind(target)
                    .execute(&mut *tx)
                    .await
                    .unwrap();
                }
            }
        }
        let text = format!("{}{}", token(target), token(good));
        let work_app = app.clone();
        let work_author = author.clone();
        let sending = tokio::spawn(async move {
            sent(
                &work_app,
                &work_author,
                channel,
                input(Uuid::new_v4(), &text),
            )
            .await
        });
        waiting(&pool).await;
        assert!(!sending.is_finished());
        tx.commit().await.unwrap();
        let message = sending.await.unwrap();
        assert_eq!(
            message["mentions"],
            json!([{"member_id":good,"name":"Member"}]),
            "{change}"
        );
        assert_eq!(mention_rows(&pool, org).await, 1);
    }
}
