use super::*;

async fn waiting(pool: &PgPool, pattern: &str, count: i64) {
    tokio::time::timeout(Duration::from_secs(5),async {
        loop {
            let n:i64=sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1")
                .bind(pattern).fetch_one(pool).await.unwrap();
            if n>=count { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
}

#[fukulow_test::test]
async fn deactivation_rereads_actor_role_activity_and_revision_after_waiting(pool: PgPool) {
    for loss in ["demoted", "deactivated", "revision"] {
        let f = Fixture::new(pool.clone()).await;
        let (actor, ot) = f.user("owner").await;
        f.user("owner").await;
        let mut blocker = f.pools.admin.begin().await.unwrap();
        auth::members::lock_organization(&mut blocker, f.org)
            .await
            .unwrap();
        let pending = {
            let app = f.app.clone();
            let target = f.creator;
            tokio::spawn(async move { deactivate(&app, &ot, target).await })
        };
        waiting(
            &f.pools.admin,
            "SELECT organization_id%FOR NO KEY UPDATE",
            1,
        )
        .await;
        let sql = match loss {
            "demoted" => "UPDATE users SET role='member' WHERE organization_id=$1 AND id=$2",
            "deactivated" => {
                "UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2"
            }
            _ => "UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2",
        };
        sqlx::query(sql)
            .bind(f.org)
            .bind(actor)
            .execute(&mut *blocker)
            .await
            .unwrap();
        if loss == "revision" {
            sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
                .bind(f.org)
                .bind(actor)
                .execute(&mut *blocker)
                .await
                .unwrap();
        }
        blocker.commit().await.unwrap();
        let before = all_state(&f.pools.admin).await;
        let response = tokio::time::timeout(Duration::from_secs(5), pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            response.status(),
            if loss == "demoted" {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::NOT_FOUND
            }
        );
        assert_eq!(
            body(response).await,
            json!({"error":if loss=="demoted"{"forbidden"}else{"organization_unavailable"}})
        );
        assert_eq!(all_state(&f.pools.admin).await, before);
        f.pools.app.close().await;
    }
}

#[fukulow_test::test]
async fn deactivation_races_with_deactivation_demotion_remove_leave_and_manager_changes(
    pool: PgPool,
) {
    for operation in ["deactivate", "demote", "remove", "leave", "revoke", "grant"] {
        for reverse in [false, true] {
            let f = Fixture::new(pool.clone()).await;
            let (b, bt) = f
                .user(if operation == "demote" {
                    "admin"
                } else {
                    "member"
                })
                .await;
            let (_, ot) = f.user("owner").await;
            f.add(b).await;
            if operation != "grant" && operation != "demote" {
                assert_eq!(
                    manager(&f.app, &f.token, f.channel, b, true).await.status(),
                    StatusCode::NO_CONTENT
                );
            }
            let (reader, _) = f.user("guest").await;
            f.add(reader).await;
            let mut blocker = f.pools.admin.begin().await.unwrap();
            auth::members::lock_organization(&mut blocker, f.org)
                .await
                .unwrap();
            let mut tasks = Vec::new();
            for second in [reverse, !reverse] {
                let app = f.app.clone();
                let ot = ot.clone();
                let at = f.token.clone();
                let bt = bt.clone();
                let a = f.creator;
                let c = f.channel;
                tasks.push(tokio::spawn(async move {
                    if !second {
                        deactivate(&app, &ot, a).await
                    } else {
                        match operation {
                            "deactivate" => deactivate(&app, &ot, b).await,
                            "demote" => change(&app, &ot, b, "guest").await,
                            "remove" => mutation(&app, &at, c, b, false).await,
                            "leave" => mutation(&app, &bt, c, b, false).await,
                            "revoke" => manager(&app, &bt, c, b, false).await,
                            _ => manager(&app, &at, c, b, true).await,
                        }
                    }
                }));
                waiting(
                    &f.pools.admin,
                    "SELECT organization_id%FOR NO KEY UPDATE",
                    tasks.len() as i64,
                )
                .await;
            }
            blocker.commit().await.unwrap();
            let first = tokio::time::timeout(Duration::from_secs(5), tasks.remove(0))
                .await
                .unwrap()
                .unwrap();
            let second = tokio::time::timeout(Duration::from_secs(5), tasks.remove(0))
                .await
                .unwrap()
                .unwrap();
            if operation == "grant" {
                assert_eq!(
                    first.status(),
                    if reverse {
                        StatusCode::NO_CONTENT
                    } else {
                        StatusCode::CONFLICT
                    }
                );
                assert_eq!(second.status(), StatusCode::NO_CONTENT);
            } else {
                assert_eq!(
                    first.status(),
                    if operation == "demote" && reverse {
                        StatusCode::OK
                    } else {
                        StatusCode::NO_CONTENT
                    },
                    "{operation} {reverse}"
                );
                let (status, error) = if operation == "remove" && !reverse {
                    (StatusCode::NOT_FOUND, "organization_unavailable")
                } else {
                    (StatusCode::CONFLICT, "last_channel_manager")
                };
                assert_eq!(second.status(), status, "{operation} {reverse}");
                assert_eq!(body(second).await, json!({"error":error}));
            }
            let managers:i64=sqlx::query_scalar("SELECT count(*) FROM channel_members cm JOIN users u ON u.organization_id=cm.organization_id AND u.id=cm.member_id AND u.membership_revision=cm.membership_revision WHERE cm.organization_id=$1 AND cm.channel_id=$2 AND u.deactivated_at IS NULL AND (u.role IN ('owner','admin') OR cm.manager)")
                .bind(f.org).bind(f.channel).fetch_one(&f.pools.admin).await.unwrap();
            assert!(managers >= 1);
            f.pools.app.close().await;
        }
    }
}

#[fukulow_test::test]
async fn deactivation_and_private_creation_serialize_in_both_orders(pool: PgPool) {
    for creation_first in [false, true] {
        let f = Fixture::new(pool.clone()).await;
        let (backup, _) = f.user("admin").await;
        f.add(backup).await;
        let (_, ot) = f.user("owner").await;
        let mut blocker = f.pools.admin.begin().await.unwrap();
        auth::members::lock_organization(&mut blocker, f.org)
            .await
            .unwrap();
        let mut tasks = Vec::new();
        for creation in [creation_first, !creation_first] {
            let app = f.app.clone();
            let at = f.token.clone();
            let ot = ot.clone();
            let a = f.creator;
            tasks.push(tokio::spawn(async move {
                if creation {
                    request(
                        &app,
                        "POST",
                        "/api/v1/channels",
                        &at,
                        json!({"name":"Racing creation","visibility":"private"}),
                    )
                    .await
                } else {
                    deactivate(&app, &ot, a).await
                }
            }));
            waiting(
                &f.pools.admin,
                "SELECT organization_id%FOR NO KEY UPDATE",
                tasks.len() as i64,
            )
            .await;
        }
        blocker.commit().await.unwrap();
        let first = tokio::time::timeout(Duration::from_secs(5), tasks.remove(0))
            .await
            .unwrap()
            .unwrap();
        let second = tokio::time::timeout(Duration::from_secs(5), tasks.remove(0))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            first.status(),
            if creation_first {
                StatusCode::CREATED
            } else {
                StatusCode::NO_CONTENT
            }
        );
        assert_eq!(
            second.status(),
            if creation_first {
                StatusCode::CONFLICT
            } else {
                StatusCode::NOT_FOUND
            }
        );
        assert_eq!(
            body(second).await,
            json!({"error":if creation_first{"last_channel_manager"}else{"organization_unavailable"}})
        );
        f.pools.app.close().await;
    }
}

#[fukulow_test::test]
async fn deactivation_locks_organization_and_sorted_channels_before_members(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let (owner, ot) = f.user("owner").await;
    let c = create(&f.app, &f.token, "Second private", "private").await;
    let mut channels = [
        f.channel,
        Uuid::parse_str(c["id"].as_str().unwrap()).unwrap(),
    ];
    channels.sort();
    let mut blocker = f.pools.admin.begin().await.unwrap();
    sqlx::query("SELECT id FROM channels WHERE organization_id=$1 AND id=$2 FOR NO KEY UPDATE")
        .bind(f.org)
        .bind(channels[1])
        .execute(&mut *blocker)
        .await
        .unwrap();
    let pending = {
        let app = f.app.clone();
        let a = f.creator;
        tokio::spawn(async move { deactivate(&app, &ot, a).await })
    };
    waiting(
        &f.pools.admin,
        "SELECT c.id FROM channels%FOR NO KEY UPDATE OF c",
        1,
    )
    .await;
    for (table, key, id) in [
        ("organizations", "organization_id", f.org),
        ("channels", "id", channels[0]),
    ] {
        let mut probe = f.pools.admin.begin().await.unwrap();
        let error=sqlx::query(&format!("SELECT {key} FROM {table} WHERE organization_id=$1 AND {key}=$2 FOR NO KEY UPDATE NOWAIT"))
            .bind(f.org).bind(id).execute(&mut *probe).await.unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("55P03")
        );
        probe.rollback().await.unwrap();
    }
    let mut probe = f.pools.admin.begin().await.unwrap();
    sqlx::query("SELECT id FROM users WHERE organization_id=$1 AND id=ANY($2) FOR UPDATE NOWAIT")
        .bind(f.org)
        .bind(&[owner, f.creator][..])
        .execute(&mut *probe)
        .await
        .unwrap();
    probe.commit().await.unwrap();
    blocker.commit().await.unwrap();
    assert_eq!(pending.await.unwrap().status(), StatusCode::CONFLICT);
    f.pools.app.close().await;
}
