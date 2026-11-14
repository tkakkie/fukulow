use super::{access::assert_positions_match_visibility, *};

pub(super) async fn role(pool: &PgPool, org: Uuid, member: Uuid, role: &str) {
    sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(member)
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
}

pub(super) async fn grant(pool: &PgPool, org: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id,membership_revision) \
        SELECT $1,$2,id,membership_revision FROM users WHERE organization_id=$1 AND id=$3 \
        ON CONFLICT (organization_id,channel_id,member_id) DO UPDATE SET membership_revision=EXCLUDED.membership_revision")
        .bind(org).bind(channel).bind(member).execute(pool).await.unwrap();
}

pub(super) async fn revoke(pool: &PgPool, org: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query(
        "DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3",
    )
    .bind(org)
    .bind(channel)
    .bind(member)
    .execute(pool)
    .await
    .unwrap();
}

pub(super) async fn position(
    pool: &PgPool,
    org: Uuid,
    channel: Uuid,
    member: Uuid,
) -> Option<(i64, i64)> {
    sqlx::query_as("SELECT initial_seq,read_seq FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
        .bind(org).bind(channel).bind(member).fetch_optional(pool).await.unwrap()
}

pub(super) async fn topic_positions(
    pool: &PgPool,
    org: Uuid,
    channel: Uuid,
    member: Uuid,
) -> Vec<i64> {
    sqlx::query_scalar("SELECT read_seq FROM topic_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 ORDER BY topic_id")
        .bind(org).bind(channel).bind(member).fetch_all(pool).await.unwrap()
}

#[fukulow_test::test]
async fn unread_guest_public_grant_starts_at_committed_seq_and_revoke_deletes_positions(
    pool: PgPool,
) {
    let (app, org, _, channel, owner) = fixture(&pool).await;
    let guest = Uuid::new_v4();
    let token = member(&pool, org, guest).await;
    role(&pool, org, guest, "guest").await;
    post(&app, &owner, channel, None).await;
    let topic = post(&app, &owner, channel, Some("Before grant")).await;
    assert_eq!(position(&pool, org, channel, guest).await, None);
    grant(&pool, org, channel, guest).await;
    assert_eq!(position(&pool, org, channel, guest).await, Some((2, 2)));
    assert_eq!(topic_positions(&pool, org, channel, guest).await, vec![2]);
    post(&app, &owner, channel, None).await;
    mark(&app, &token, channel, None, 3).await;
    mark(&app, &token, channel, topic["topic_id"].as_str(), 3).await;
    // Updating an already current grant must keep both positions, not restart.
    grant(&pool, org, channel, guest).await;
    assert_eq!(position(&pool, org, channel, guest).await, Some((2, 3)));
    assert_eq!(topic_positions(&pool, org, channel, guest).await, vec![3]);
    revoke(&pool, org, channel, guest).await;
    assert_eq!(position(&pool, org, channel, guest).await, None);
    assert!(topic_positions(&pool, org, channel, guest).await.is_empty());
    assert_eq!(channels(&app, &token).await["channels"], json!([]));
    post(&app, &owner, channel, None).await;
    grant(&pool, org, channel, guest).await;
    assert_eq!(position(&pool, org, channel, guest).await, Some((4, 4)));
    assert_eq!(topic_positions(&pool, org, channel, guest).await, vec![4]);
    assert_positions_match_visibility(&pool).await;
}

#[fukulow_test::test]
async fn unread_role_changes_preserve_continuous_positions_and_initialize_new_access(pool: PgPool) {
    let (app, org, owner_id, public, owner) = fixture(&pool).await;
    role(&pool, org, owner_id, "owner").await;
    let granted = Uuid::new_v4();
    let private = Uuid::new_v4();
    super::super::channel(&pool, org, granted, owner_id, false).await;
    super::super::channel(&pool, org, private, owner_id, true).await;
    let guest = Uuid::new_v4();
    let token = member(&pool, org, guest).await;
    role(&pool, org, guest, "guest").await;
    for c in [public, granted, private] {
        post(&app, &owner, c, Some("Preserved")).await;
    }
    for c in [granted, private] {
        grant(&pool, org, c, guest).await;
        post(&app, &owner, c, None).await;
        mark(&app, &token, c, None, 2).await;
    }
    post(&app, &owner, public, None).await;
    for (index, next) in ["member", "admin", "owner", "admin", "member", "guest"]
        .into_iter()
        .enumerate()
    {
        role(&pool, org, guest, next).await;
        assert_eq!(
            position(&pool, org, public, guest).await,
            if next == "guest" { None } else { Some((2, 2)) },
            "{next}"
        );
        for c in [granted, private] {
            assert_eq!(position(&pool, org, c, guest).await, Some((1, 2)), "{next}");
            assert_eq!(
                topic_positions(&pool, org, c, guest).await,
                vec![1],
                "{next}"
            );
            grant(&pool, org, c, guest).await;
            assert_eq!(position(&pool, org, c, guest).await, Some((1, 2)));
        }
        assert_positions_match_visibility(&pool).await;
        if index == 0 {
            // Later Role changes must not reset the newly acquired public
            // position to a newer baseline, even with no explicit grant.
            post(&app, &owner, public, None).await;
        }
    }
    // Every non-Guest Role loses only the ungranted public shortcut on demotion.
    for previous in ["member", "admin", "owner"] {
        role(&pool, org, guest, previous).await;
        role(&pool, org, guest, "guest").await;
        assert_eq!(position(&pool, org, public, guest).await, None);
        for c in [granted, private] {
            assert_eq!(position(&pool, org, c, guest).await, Some((1, 2)));
        }
    }
}

#[fukulow_test::test]
async fn unread_guest_creation_activation_and_public_channel_creation_require_grants(pool: PgPool) {
    let (_, org, owner, public, _) = fixture(&pool).await;
    let account = Uuid::new_v4();
    let guest = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id,email,password_hash) VALUES ($1,$2,'unused')")
        .bind(account)
        .bind(format!("{account}@example.com"))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (organization_id,id,account_id,name,role) VALUES ($1,$2,$3,'Guest','guest')")
        .bind(org).bind(guest).bind(account).execute(&pool).await.unwrap();
    assert_eq!(position(&pool, org, public, guest).await, None);
    let created = Uuid::new_v4();
    super::super::channel(&pool, org, created, owner, false).await;
    assert_eq!(position(&pool, org, created, guest).await, None);
    grant(&pool, org, public, guest).await;
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(guest)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(guest)
        .execute(&pool)
        .await
        .unwrap();
    // The historical revision-zero public grant cannot revive Guest access.
    assert_eq!(position(&pool, org, public, guest).await, None);
    assert_eq!(position(&pool, org, created, guest).await, None);
    grant(&pool, org, public, guest).await;
    assert_eq!(position(&pool, org, public, guest).await, Some((0, 0)));
    assert_positions_match_visibility(&pool).await;
}

#[fukulow_test::test]
async fn unread_all_roles_visibility_grants_and_access_changes_match_positions(pool: PgPool) {
    let (app, org, owner, _, owner_token) = fixture(&pool).await;
    role(&pool, org, owner, "owner").await;
    // Include a second scope in every comparison against production visibility.
    let _ = fixture(&pool).await;
    for initial_role in crate::auth::ALL_ROLES {
        let initial_role = serde_json::to_value(initial_role).unwrap();
        let initial_role = initial_role.as_str().unwrap();
        for private in [false, true] {
            for granted in [false, true] {
                let viewer = Uuid::new_v4();
                let viewer_token = member(&pool, org, viewer).await;
                role(&pool, org, viewer, initial_role).await;
                let channel = Uuid::new_v4();
                super::super::channel(&pool, org, channel, owner, private).await;
                if granted {
                    grant(&pool, org, channel, viewer).await;
                }
                assert_positions_match_visibility(&pool).await;
                for next in crate::auth::ALL_ROLES {
                    let next = serde_json::to_value(next).unwrap();
                    role(&pool, org, viewer, next.as_str().unwrap()).await;
                    assert_positions_match_visibility(&pool).await;
                    role(&pool, org, viewer, initial_role).await;
                    assert_positions_match_visibility(&pool).await;
                }
                for visibility in [
                    "public",
                    "private",
                    if private { "private" } else { "public" },
                ] {
                    sqlx::query(
                        "UPDATE channels SET visibility=$3 WHERE organization_id=$1 AND id=$2",
                    )
                    .bind(org)
                    .bind(channel)
                    .bind(visibility)
                    .execute(&pool)
                    .await
                    .unwrap();
                    assert_positions_match_visibility(&pool).await;
                }
                grant(&pool, org, channel, viewer).await;
                assert_positions_match_visibility(&pool).await;
                grant(&pool, org, channel, viewer).await;
                assert_positions_match_visibility(&pool).await;
                sqlx::query("UPDATE channel_members SET membership_revision=membership_revision+1 WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                    .bind(org).bind(channel).bind(viewer).execute(&pool).await.unwrap();
                assert_positions_match_visibility(&pool).await;
                grant(&pool, org, channel, viewer).await;
                assert_positions_match_visibility(&pool).await;
                revoke(&pool, org, channel, viewer).await;
                assert_positions_match_visibility(&pool).await;
                if granted {
                    grant(&pool, org, channel, viewer).await;
                }
                sqlx::query(
                    "UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2",
                )
                .bind(org)
                .bind(viewer)
                .execute(&pool)
                .await
                .unwrap();
                assert_positions_match_visibility(&pool).await;
                if granted {
                    grant(&pool, org, channel, viewer).await;
                }
                assert_positions_match_visibility(&pool).await;
                sqlx::query(
                    "UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2",
                )
                .bind(org)
                .bind(viewer)
                .execute(&pool)
                .await
                .unwrap();
                assert_positions_match_visibility(&pool).await;
                revoke(&pool, org, channel, viewer).await;
                assert_positions_match_visibility(&pool).await;
                // #149 explicit stale renewal, duplicate add, leave and removal
                // must use the same lifecycle predicate as production visibility.
                sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id,membership_revision) SELECT organization_id,$2,id,membership_revision-1 FROM users WHERE organization_id=$1 AND id=$3")
                    .bind(org).bind(channel).bind(viewer).execute(&pool).await.unwrap();
                assert_positions_match_visibility(&pool).await;
                for _ in 0..2 {
                    assert_eq!(
                        request(
                            &app,
                            "POST",
                            &format!("/api/v1/channels/{channel}/members"),
                            &owner_token,
                            json!({"member_id":viewer})
                        )
                        .await
                        .status(),
                        StatusCode::NO_CONTENT
                    );
                    assert_positions_match_visibility(&pool).await;
                }
                assert_eq!(
                    request(
                        &app,
                        "DELETE",
                        &format!("/api/v1/channels/{channel}/members/{viewer}"),
                        &viewer_token,
                        Value::Null
                    )
                    .await
                    .status(),
                    StatusCode::NO_CONTENT
                );
                assert_positions_match_visibility(&pool).await;
                assert_eq!(
                    request(
                        &app,
                        "POST",
                        &format!("/api/v1/channels/{channel}/members"),
                        &owner_token,
                        json!({"member_id":viewer})
                    )
                    .await
                    .status(),
                    StatusCode::NO_CONTENT
                );
                assert_eq!(
                    request(
                        &app,
                        "DELETE",
                        &format!("/api/v1/channels/{channel}/members/{viewer}"),
                        &owner_token,
                        Value::Null
                    )
                    .await
                    .status(),
                    StatusCode::NO_CONTENT
                );
                assert_positions_match_visibility(&pool).await;
            }
        }
    }
}

#[fukulow_test::test(migrations = false)]
async fn unread_access_migration_repairs_guest_rows_and_backfills_without_resetting(pool: PgPool) {
    let mut paths =
        std::fs::read_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.file_name().unwrap().to_str().unwrap() < "202611110201_unread_access.sql")
            .collect::<Vec<_>>();
    paths.sort();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&pool)
            .await
            .unwrap();
    }
    let (_, org, owner_id, public, _) = fixture(&pool).await;
    let guest = Uuid::new_v4();
    member(&pool, org, guest).await;
    let granted = Uuid::new_v4();
    let private = Uuid::new_v4();
    let missing = Uuid::new_v4();
    for (c, private) in [(granted, false), (private, true), (missing, false)] {
        super::super::channel(&pool, org, c, owner_id, private).await;
        historical_post(&pool, org, owner_id, c, Some("Before migration")).await;
    }
    historical_post(&pool, org, owner_id, public, Some("Must disappear")).await;
    grant(&pool, org, granted, guest).await;
    grant(&pool, org, private, guest).await;
    role(&pool, org, guest, "guest").await;
    // Model stale Topic rows and a missing visible row from before the fix.
    sqlx::query("INSERT INTO topic_read_positions SELECT p.organization_id,p.channel_id,p.member_id,t.id,1 \
        FROM channel_read_positions p JOIN topics t ON t.organization_id=p.organization_id AND t.channel_id=p.channel_id \
        WHERE p.organization_id=$1 AND p.member_id=$2 ON CONFLICT DO NOTHING")
        .bind(org).bind(guest).execute(&pool).await.unwrap();
    sqlx::query(
        "UPDATE channel_read_positions SET read_seq=1 WHERE organization_id=$1 AND member_id=$2",
    )
    .bind(org)
    .bind(guest)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
        .bind(org).bind(missing).bind(owner_id).execute(&pool).await.unwrap();
    let preserved = position(&pool, org, granted, guest).await;
    let private_before = position(&pool, org, private, guest).await;
    assert!(position(&pool, org, public, guest).await.is_some());
    sqlx::raw_sql(include_str!(
        "../../../../migrations/202611110201_unread_access.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(position(&pool, org, public, guest).await, None);
    assert!(topic_positions(&pool, org, public, guest).await.is_empty());
    assert_eq!(position(&pool, org, granted, guest).await, preserved);
    assert_eq!(position(&pool, org, private, guest).await, private_before);
    assert_eq!(topic_positions(&pool, org, granted, guest).await, vec![1]);
    assert_eq!(position(&pool, org, missing, owner_id).await, Some((1, 1)));
    assert_eq!(
        topic_positions(&pool, org, missing, owner_id).await,
        vec![1]
    );
    assert_positions_match_visibility(&pool).await;
}

#[fukulow_test::test]
async fn unread_guest_grant_and_promotion_wait_for_committed_baseline_and_hold_it(pool: PgPool) {
    for promote in [false, true] {
        for commit_send in [false, true] {
            let (app, org, _, channel, owner) = fixture(&pool).await;
            let guest = Uuid::new_v4();
            member(&pool, org, guest).await;
            role(&pool, org, guest, "guest").await;
            post(&app, &owner, channel, None).await;
            let key = Uuid::new_v4();
            let pending = ambiguous_commit(key);
            send(&app, &owner, channel, input(key, "Pending access baseline")).await;
            let pending = pending.await.unwrap();
            let work_pool = pool.clone();
            let gaining = tokio::spawn(async move {
                let mut tx = work_pool.begin().await.unwrap();
                if promote {
                    sqlx::query(
                        "UPDATE users SET role='member' WHERE organization_id=$1 AND id=$2",
                    )
                    .bind(org)
                    .bind(guest)
                    .execute(&mut *tx)
                    .await
                    .unwrap();
                } else {
                    sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)")
                        .bind(org).bind(channel).bind(guest).execute(&mut *tx).await.unwrap();
                }
                tx
            });
            super::concurrency::waiting(
                &pool,
                if promote {
                    "UPDATE users%"
                } else {
                    "INSERT INTO channel_members%"
                },
            )
            .await;
            assert!(!gaining.is_finished());
            if commit_send {
                pending.commit().await.unwrap();
            } else {
                pending.rollback().await.unwrap();
            }
            let tx = gaining.await.unwrap();
            let work_app = app.clone();
            let sending = tokio::spawn(async move { post(&work_app, &owner, channel, None).await });
            super::concurrency::waiting(&pool, "%135%").await;
            assert!(!sending.is_finished());
            tx.commit().await.unwrap();
            let baseline = if commit_send { 2 } else { 1 };
            assert_eq!(sending.await.unwrap()["seq"], baseline + 1);
            assert_eq!(
                position(&pool, org, channel, guest).await,
                Some((baseline, baseline))
            );
            assert_positions_match_visibility(&pool).await;
        }
    }
}

#[fukulow_test::test]
async fn unread_role_channel_and_grant_races_reconcile_after_organization_lock(pool: PgPool) {
    let (_, org, owner, _, _) = fixture(&pool).await;
    let viewer = Uuid::new_v4();
    member(&pool, org, viewer).await;
    for next in ["guest", "member"] {
        let channel = Uuid::new_v4();
        let mut tx = pool.begin().await.unwrap();
        sqlx::query(
            "INSERT INTO channels (organization_id,id,name,visibility) VALUES ($1,$2,$3,'public')",
        )
        .bind(org)
        .bind(channel)
        .bind(channel.to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
        let work_pool = pool.clone();
        let changing = tokio::spawn(async move { role(&work_pool, org, viewer, next).await });
        super::concurrency::waiting(&pool, "UPDATE users%").await;
        tx.commit().await.unwrap();
        changing.await.unwrap();
        assert_positions_match_visibility(&pool).await;
    }
    // Both commit orders for a grant racing Guest demotion: the waiting trigger
    // must query fresh visibility after acquiring #142's Organization lock.
    for grant_first in [false, true] {
        let channel = Uuid::new_v4();
        super::super::channel(&pool, org, channel, owner, false).await;
        role(&pool, org, viewer, "member").await;
        let mut tx = pool.begin().await.unwrap();
        let work_pool = pool.clone();
        let changing = if grant_first {
            sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)")
                .bind(org).bind(channel).bind(viewer).execute(&mut *tx).await.unwrap();
            let task = tokio::spawn(async move { role(&work_pool, org, viewer, "guest").await });
            super::concurrency::waiting(&pool, "UPDATE users%").await;
            task
        } else {
            sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(viewer)
                .execute(&mut *tx)
                .await
                .unwrap();
            let task = tokio::spawn(async move { grant(&work_pool, org, channel, viewer).await });
            super::concurrency::waiting(&pool, "INSERT INTO channel_members%").await;
            task
        };
        tx.commit().await.unwrap();
        changing.await.unwrap();
        assert_eq!(position(&pool, org, channel, viewer).await, Some((0, 0)));
        assert_positions_match_visibility(&pool).await;
    }
}
