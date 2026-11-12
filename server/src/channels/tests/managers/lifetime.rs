use super::*;

#[sqlx::test]
async fn channel_manager_last_manager_denials_and_unmanaged_controls(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let (_, ot) = f.user("owner").await;
    for role in ["member", "guest"] {
        let (id, _) = f.user(role).await;
        f.add(id).await;
    }
    for operation in ["revoke", "remove", "leave", "guest"] {
        let before = snapshot(&f.pools.admin).await;
        let calls = f.observed.calls.load(Ordering::SeqCst);
        let response = match operation {
            "revoke" => manager(&f.app, &f.token, f.channel, f.creator, false).await,
            "guest" => change(&f.app, &ot, f.creator, "guest").await,
            _ => mutation(&f.app, &f.token, f.channel, f.creator, false).await,
        };
        assert_eq!(response.status(), StatusCode::CONFLICT, "{operation}");
        assert_eq!(
            body(response).await,
            json!({"error":"last_channel_manager"})
        );
        assert_eq!(snapshot(&f.pools.admin).await, before);
        assert_eq!(f.observed.calls.load(Ordering::SeqCst), calls);
    }
    // A Role-only manager still cannot demote without a replacement.
    assert_eq!(
        change(&f.app, &ot, f.creator, "admin").await.status(),
        StatusCode::OK
    );
    assert_eq!(
        manager(&f.app, &f.token, f.channel, f.creator, false)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let response = change(&f.app, &ot, f.creator, "member").await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        body(response).await,
        json!({"error":"last_channel_manager"})
    );
    // No backfill: direct legacy fixture is already unmanaged, so may lose grants.
    sqlx::query("UPDATE users SET role='member' WHERE organization_id=$1 AND id=$2")
        .bind(f.org)
        .bind(f.creator)
        .execute(&f.pools.admin)
        .await
        .unwrap();
    assert_eq!(
        mutation(&f.app, &f.token, f.channel, f.creator, false)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    f.pools.app.close().await;
}

#[sqlx::test]
async fn channel_manager_role_changes_are_atomic_and_preserve_grant_subscription_and_unread(
    pool: PgPool,
) {
    let f = Fixture::new(pool).await;
    let (_, ot) = f.user("owner").await;
    let (backup, _) = f.user("member").await;
    f.add(backup).await;
    assert_eq!(
        manager(&f.app, &f.token, f.channel, backup, true)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let second = create(&f.app, &f.token, "Second private", "private").await;
    let second = Uuid::parse_str(second["id"].as_str().unwrap()).unwrap();
    let sent = request(&f.app,"POST",&format!("/api/v1/channels/{}/messages",f.channel),&f.token,json!({"client_message_id":Uuid::new_v4(),"body":"Preserve Topic position","topic_name":"Topic"})).await;
    assert_eq!(sent.status(), StatusCode::CREATED);
    let sent = body(sent).await;
    let topic = sent["topic_id"].as_str().unwrap();
    assert_eq!(
        request(
            &f.app,
            "PUT",
            &format!("/api/v1/channels/{}/topics/{topic}/read", f.channel),
            &f.token,
            json!({"read_seq":1})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let watch = f
        .observed
        .access
        .subscribe(&f.pools.app, f.org, (f.creator, 0), f.channel)
        .await
        .unwrap()
        .unwrap();
    let original = f.right(f.creator).await.0;
    for role in ["owner", "member", "admin", "member"] {
        assert_eq!(
            change(&f.app, &ot, f.creator, role).await.status(),
            StatusCode::OK
        );
        assert_eq!(f.right(f.creator).await, (original, true));
    }
    let before = snapshot(&f.pools.admin).await;
    let response = change(&f.app, &ot, f.creator, "guest").await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        body(response).await,
        json!({"error":"last_channel_manager"})
    );
    assert_eq!(snapshot(&f.pools.admin).await, before);
    assert_eq!(watch.status(), 0);
    assert_eq!(
        mutation(&f.app, &f.token, second, backup, true)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        manager(&f.app, &f.token, second, backup, true)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let positions: Value = sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(p) ORDER BY channel_id) FROM channel_read_positions p WHERE organization_id=$1 AND member_id=$2").bind(f.org).bind(f.creator).fetch_one(&f.pools.admin).await.unwrap();
    let topic_positions: Value = sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(p) ORDER BY channel_id,topic_id) FROM topic_read_positions p WHERE organization_id=$1 AND member_id=$2").bind(f.org).bind(f.creator).fetch_one(&f.pools.admin).await.unwrap();
    assert!(!topic_positions.is_null());
    for role in ["guest", "admin", "member"] {
        assert_eq!(
            change(&f.app, &ot, f.creator, role).await.status(),
            StatusCode::OK
        );
        assert_eq!(f.right(f.creator).await, (original, false));
        let after: Value = sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(p) ORDER BY channel_id) FROM channel_read_positions p WHERE organization_id=$1 AND member_id=$2").bind(f.org).bind(f.creator).fetch_one(&f.pools.admin).await.unwrap();
        assert_eq!(positions, after);
        let after: Value = sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(p) ORDER BY channel_id,topic_id) FROM topic_read_positions p WHERE organization_id=$1 AND member_id=$2").bind(f.org).bind(f.creator).fetch_one(&f.pools.admin).await.unwrap();
        assert_eq!(topic_positions, after);
        assert_eq!(watch.status(), 0);
    }
    f.pools.app.close().await;
}

#[sqlx::test]
async fn channel_manager_inactive_and_stale_rights_never_count_as_managers(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let (guest, _) = f.user("guest").await;
    f.add(guest).await;
    let (backup, _) = f.user("member").await;
    f.add(backup).await;
    assert_eq!(
        manager(&f.app, &f.token, f.channel, backup, true)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(f.org)
        .bind(backup)
        .execute(&f.pools.admin)
        .await
        .unwrap();
    // Fault injection: distinguish inactive from stale. A current-revision
    // grant on an inactive Member still must not count as a usable manager.
    sqlx::query("UPDATE channel_members SET membership_revision=membership_revision+1 WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
        .bind(f.org).bind(f.channel).bind(backup).execute(&f.pools.admin).await.unwrap();
    for reactivate in [false, true] {
        if reactivate {
            // Restore the naturally stale grant before reactivation.
            sqlx::query("UPDATE channel_members SET membership_revision=membership_revision-1 WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                .bind(f.org).bind(f.channel).bind(backup).execute(&f.pools.admin).await.unwrap();
            sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
                .bind(f.org)
                .bind(backup)
                .execute(&f.pools.admin)
                .await
                .unwrap();
        }
        f.denied(
            &f.token,
            f.channel,
            f.creator,
            false,
            StatusCode::CONFLICT,
            "last_channel_manager",
        )
        .await;
        let response = mutation(&f.app, &f.token, f.channel, f.creator, false).await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            body(response).await,
            json!({"error":"last_channel_manager"})
        );
    }
    f.add(backup).await;
    assert!(!f.right(backup).await.1);
    assert_eq!(
        manager(&f.app, &f.token, f.channel, backup, true)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        manager(&f.app, &f.token, f.channel, f.creator, false)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    f.pools.app.close().await;
}

#[sqlx::test]
async fn channel_manager_new_lifetimes_never_revive_right_or_old_subscription(pool: PgPool) {
    use auth::{SubscriptionRecheck, SubscriptionScope};
    let f = Fixture::new(pool).await;
    let (target, _) = f.user("member").await;
    for renewal in [false, true] {
        f.add(target).await;
        assert_eq!(
            manager(&f.app, &f.token, f.channel, target, true)
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        let old = f.right(target).await.0;
        // Independent registry deliberately drops the fast signal (#149).
        let access = super::super::super::access::AccessChanges::default();
        let watch = access
            .subscribe(&f.pools.app, f.org, (target, 0), f.channel)
            .await
            .unwrap()
            .unwrap();
        if renewal {
            sqlx::query("UPDATE channel_members SET membership_revision=-1 WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(f.org).bind(f.channel).bind(target).execute(&f.pools.admin).await.unwrap();
        } else {
            assert_eq!(
                mutation(&f.app, &f.token, f.channel, target, false)
                    .await
                    .status(),
                StatusCode::NO_CONTENT
            );
        }
        f.add(target).await;
        let (new, right) = f.right(target).await;
        assert_ne!(old, new);
        assert!(!right);
        access
            .check(&f.pools.app, SubscriptionScope::All)
            .await
            .unwrap();
        assert_eq!(watch.status(), 1);
        let fresh = access
            .subscribe(&f.pools.app, f.org, (target, 0), f.channel)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fresh.status(), 0);
    }
    f.pools.app.close().await;
}

#[sqlx::test]
async fn channel_manager_invite_reactivation_leaves_stale_right_unusable_and_renewal_clears_it(
    pool: PgPool,
) {
    use auth::{SubscriptionRecheck, SubscriptionScope};
    let f = Fixture::new(pool).await;
    let (target, token) = f.user("member").await;
    let (_, ot) = f.user("owner").await;
    f.add(target).await;
    assert_eq!(
        manager(&f.app, &f.token, f.channel, target, true)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let old = f.right(target).await.0;
    let access = super::super::super::access::AccessChanges::default();
    let watch = access
        .subscribe(&f.pools.app, f.org, (target, 0), f.channel)
        .await
        .unwrap()
        .unwrap();
    let email: String = sqlx::query_scalar("SELECT a.email FROM accounts a JOIN users u ON u.account_id=a.id WHERE u.organization_id=$1 AND u.id=$2").bind(f.org).bind(target).fetch_one(&f.pools.admin).await.unwrap();
    let invite = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{}/invites", f.org),
        &ot,
        json!({"email":email,"role":"member"}),
    )
    .await;
    assert_eq!(invite.status(), StatusCode::CREATED);
    let invite = body(invite).await;
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(f.org)
        .bind(target)
        .execute(&f.pools.admin)
        .await
        .unwrap();
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{}/invites/accept", f.org),
        &token,
        json!({"email":email,"token":invite["token"],"name":"Reactivated"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(f.right(target).await, (old, true)); // Retained stale data grants nothing.
    assert_eq!(
        manager(&f.app, &token, f.channel, f.creator, false)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &f.app,
            "GET",
            &format!("/api/v1/channels/{}/messages", f.channel),
            &token,
            Value::Null
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert!(
        access
            .subscribe(&f.pools.app, f.org, (target, 1), f.channel)
            .await
            .unwrap()
            .is_none()
    );
    access
        .check(&f.pools.app, SubscriptionScope::All)
        .await
        .unwrap();
    assert_eq!(watch.status(), 3); // Membership loss retains #146's 4003 classification.
    f.add(target).await;
    assert_ne!(f.right(target).await.0, old);
    assert!(!f.right(target).await.1);
    assert!(
        access
            .subscribe(&f.pools.app, f.org, (target, 1), f.channel)
            .await
            .unwrap()
            .is_some()
    );
    f.pools.app.close().await;
}

#[sqlx::test]
async fn channel_manager_migration_has_no_backfill_and_rejects_public_or_guest_rights(
    pool: PgPool,
) {
    let f = Fixture::new(pool).await;
    let public = create(&f.app, &f.token, "Public", "public").await;
    let public = Uuid::parse_str(public["id"].as_str().unwrap()).unwrap();
    let (guest, _) = f.user("guest").await;
    for (channel, target) in [(public, f.creator), (f.channel, guest)] {
        let error = crate::database::organization(
            &f.pools.app,
            f.org,
            async |tx: &mut sqlx::PgConnection| {
                sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id,manager) VALUES ($1,$2,$3,true)")
                    .bind(f.org).bind(channel).bind(target).execute(tx).await
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().constraint(),
            Some("channel_members_manager")
        );
    }
    let error =
        crate::database::organization(&f.pools.app, f.org, async |tx: &mut sqlx::PgConnection| {
            sqlx::query(
                "UPDATE channels SET visibility='public' WHERE organization_id=$1 AND id=$2",
            )
            .bind(f.org)
            .bind(f.channel)
            .execute(tx)
            .await
        })
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().constraint(),
        Some("channel_members_manager")
    );
    // Reapply just this migration over a pre-#311 schema in a rolled-back fixture.
    let mut tx = f.pools.admin.begin().await.unwrap();
    sqlx::raw_sql("DROP TRIGGER channel_members_manager ON channel_members; DROP TRIGGER channels_manager_visibility ON channels; DROP FUNCTION check_channel_manager(); DROP FUNCTION check_public_channel_managers(); ALTER TABLE channel_members DROP COLUMN manager;").execute(&mut *tx).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../migrations/202611130311_channel_managers.sql"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM channel_members WHERE organization_id=$1 AND manager",
    )
    .bind(f.org)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(count, 0);
    tx.rollback().await.unwrap();
    f.pools.app.close().await;
}

#[sqlx::test]
async fn channel_manager_public_visibility_race_cannot_commit_a_right_on_public(pool: PgPool) {
    for grant_first in [false, true] {
        let f = Fixture::new(pool.clone()).await;
        // Model a legacy unmanaged Channel. Both competing statements are
        // direct SQL so this tests the migration, independently of API locks.
        sqlx::query(
            "UPDATE channel_members SET manager=false WHERE organization_id=$1 AND channel_id=$2",
        )
        .bind(f.org)
        .bind(f.channel)
        .execute(&f.pools.admin)
        .await
        .unwrap();
        let (target, _) = f.user("member").await;
        let mut tx = f.pools.admin.begin().await.unwrap();
        let grant_sql = "INSERT INTO channel_members (organization_id,channel_id,member_id,manager) VALUES ($1,$2,$3,true)";
        let visibility_sql =
            "UPDATE channels SET visibility='public' WHERE organization_id=$1 AND id=$2";
        if grant_first {
            sqlx::query(grant_sql)
                .bind(f.org)
                .bind(f.channel)
                .bind(target)
                .execute(&mut *tx)
                .await
                .unwrap();
        } else {
            sqlx::query(visibility_sql)
                .bind(f.org)
                .bind(f.channel)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        let app = f.pools.app.clone();
        let org = f.org;
        let channel = f.channel;
        let pending = tokio::spawn(async move {
            crate::database::organization(&app, org, async |tx: &mut sqlx::PgConnection| {
                if grant_first {
                    sqlx::query(visibility_sql)
                        .bind(org)
                        .bind(channel)
                        .execute(tx)
                        .await
                } else {
                    sqlx::query(grant_sql)
                        .bind(org)
                        .bind(channel)
                        .bind(target)
                        .execute(tx)
                        .await
                }
            })
            .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(3),async {
            loop {
                let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE 'INSERT INTO channel_members%' OR query LIKE 'UPDATE channels SET visibility=%'))").fetch_one(&f.pools.admin).await.unwrap();
                if waiting || pending.is_finished() {break;}
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        assert!(
            !pending.is_finished(),
            "visibility and manager writes must serialize"
        );
        tx.commit().await.unwrap();
        let error = tokio::time::timeout(std::time::Duration::from_secs(3), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().constraint(),
            Some("channel_members_manager")
        );
        let invalid: i64 = sqlx::query_scalar("SELECT count(*) FROM channels c JOIN channel_members cm ON cm.organization_id=c.organization_id AND cm.channel_id=c.id WHERE c.organization_id=$1 AND c.visibility='public' AND cm.manager").bind(f.org).fetch_one(&f.pools.admin).await.unwrap();
        assert_eq!(invalid, 0);
        f.pools.app.close().await;
    }
}
