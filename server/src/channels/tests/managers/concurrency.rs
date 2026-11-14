use super::*;
use std::time::Duration;

async fn wait_for_organization(pool: &PgPool, count: i64) {
    tokio::time::timeout(Duration::from_secs(3),async {
        loop {
            let waiting: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT organization_id%FOR NO KEY UPDATE'")
                .fetch_one(pool).await.unwrap();
            if waiting >= count { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
}

#[fukulow_test::test]
async fn channel_manager_concurrent_revoke_leave_role_and_removal_preserve_manager(pool: PgPool) {
    // Queue both orders behind the real Organization lock; no timing assumption
    // decides which operation wins, and every task has a deadlock deadline.
    for operation in ["mutual", "self", "leave", "role", "remove", "transfer"] {
        for reverse in [false, true] {
            let f = Fixture::new(pool.clone()).await;
            let (b, bt) = f.user("member").await;
            let (_, ot) = f.user("owner").await;
            f.add(b).await;
            if operation != "transfer" && operation != "remove" {
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
                let at = f.token.clone();
                let bt = bt.clone();
                let ot = ot.clone();
                let a = f.creator;
                let c = f.channel;
                tasks.push(tokio::spawn(async move {
                    if !second {
                        match operation {
                            "mutual" => manager(&app, &at, c, b, false).await,
                            "remove" => mutation(&app, &at, c, b, false).await,
                            "transfer" => manager(&app, &at, c, b, true).await,
                            _ => manager(&app, &at, c, a, false).await,
                        }
                    } else {
                        match operation {
                            "mutual" => manager(&app, &bt, c, a, false).await,
                            "leave" => mutation(&app, &bt, c, b, false).await,
                            "role" => change(&app, &ot, b, "guest").await,
                            "remove" => manager(&app, &at, c, b, true).await,
                            "transfer" => mutation(&app, &at, c, a, false).await,
                            _ => manager(&app, &bt, c, b, false).await,
                        }
                    }
                }));
                wait_for_organization(&f.pools.admin, tasks.len() as i64).await;
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
            if operation == "transfer" && reverse {
                assert_eq!(first.status(), StatusCode::CONFLICT);
                assert_eq!(body(first).await, json!({"error":"last_channel_manager"}));
                assert_eq!(second.status(), StatusCode::NO_CONTENT);
            } else {
                assert_eq!(
                    first.status(),
                    if operation == "role" && reverse {
                        StatusCode::OK
                    } else {
                        StatusCode::NO_CONTENT
                    },
                    "{operation} {reverse}"
                );
                let expected = match operation {
                    "mutual" => StatusCode::FORBIDDEN,
                    "remove" if !reverse => StatusCode::NOT_FOUND,
                    "remove" | "transfer" => StatusCode::NO_CONTENT,
                    _ => StatusCode::CONFLICT,
                };
                assert_eq!(second.status(), expected, "{operation} {reverse}");
                if expected == StatusCode::CONFLICT {
                    assert_eq!(body(second).await, json!({"error":"last_channel_manager"}));
                }
            }
            let managers: i64 = sqlx::query_scalar("SELECT count(*) FROM channel_members cm JOIN users u ON u.organization_id=cm.organization_id AND u.id=cm.member_id AND u.membership_revision=cm.membership_revision WHERE cm.organization_id=$1 AND cm.channel_id=$2 AND u.deactivated_at IS NULL AND (u.role IN ('owner','admin') OR (cm.manager AND u.role<>'guest'))")
                .bind(f.org).bind(f.channel).fetch_one(&f.pools.admin).await.unwrap();
            assert!(
                managers > 0,
                "{operation} {reverse} lost its last usable manager"
            );
            if operation == "remove" {
                let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3)").bind(f.org).bind(f.channel).bind(b).fetch_one(&f.pools.admin).await.unwrap();
                assert!(
                    !exists,
                    "a concurrent PATCH must never recreate a removed grant"
                );
            }
            f.pools.app.close().await;
        }
    }
}

#[fukulow_test::test]
async fn channel_manager_mutation_locks_members_before_grants(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let (target, _) = f.user("member").await;
    f.add(target).await;
    let mut blocker = f.pools.admin.begin().await.unwrap();
    sqlx::query("SELECT id FROM users WHERE organization_id=$1 AND id=$2 FOR UPDATE")
        .bind(f.org)
        .bind(target)
        .execute(&mut *blocker)
        .await
        .unwrap();
    let app = f.app.clone();
    let token = f.token.clone();
    let c = f.channel;
    let pending = tokio::spawn(async move { manager(&app, &token, c, target, true).await });
    tokio::time::timeout(Duration::from_secs(3),async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT name,role,membership_revision%FOR NO KEY UPDATE')").fetch_one(&f.pools.admin).await.unwrap();
            if waiting {break;}
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    // Waiting for a target Member must not hold even the actor's grant yet.
    sqlx::query("SELECT member_id FROM channel_members WHERE organization_id=$1 AND channel_id=$2 FOR UPDATE NOWAIT").bind(f.org).bind(c).execute(&mut *blocker).await.unwrap();
    blocker.commit().await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), pending)
            .await
            .unwrap()
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn channel_manager_guest_change_and_send_never_invert_member_grant_locks(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let (backup, ot) = f.user("owner").await;
    f.add(backup).await;
    let mut blocker = f.pools.admin.begin().await.unwrap();
    sqlx::query("SELECT member_id FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 FOR SHARE").bind(f.org).bind(f.channel).bind(f.creator).execute(&mut *blocker).await.unwrap();
    let app = f.app.clone();
    let target = f.creator;
    let role_change = tokio::spawn(async move { change(&app, &ot, target, "guest").await });
    tokio::time::timeout(Duration::from_secs(3),async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE channel_members SET manager=false%')").fetch_one(&f.pools.admin).await.unwrap();
            if waiting {break;}
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    let blocked =
        sqlx::query("SELECT id FROM users WHERE organization_id=$1 AND id=$2 FOR SHARE NOWAIT")
            .bind(f.org)
            .bind(target)
            .execute(&f.pools.admin)
            .await
            .unwrap_err();
    assert_eq!(
        blocked.as_database_error().unwrap().code().as_deref(),
        Some("55P03")
    );
    let app = f.app.clone();
    let token = f.token.clone();
    let c = f.channel;
    let send = tokio::spawn(async move {
        request(
            &app,
            "POST",
            &format!("/api/v1/channels/{c}/messages"),
            &token,
            json!({"client_message_id":Uuid::new_v4(),"body":"Continuous private access"}),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(3),async {
        loop {
            let waiting: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE 'UPDATE channel_members SET manager=false%' OR query LIKE 'SELECT role FROM (%' OR query LIKE 'SELECT member_id FROM channel_members%' OR query LIKE 'SELECT visibility=%' OR query LIKE 'SELECT id,membership_revision,role FROM users%')").fetch_one(&f.pools.admin).await.unwrap();
            if waiting >= 2 {break;}
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    blocker.commit().await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), role_change)
            .await
            .unwrap()
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), send)
            .await
            .unwrap()
            .unwrap()
            .status(),
        StatusCode::CREATED
    );
    assert!(!f.right(target).await.1);
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn channel_manager_right_only_changes_skip_unread_locks_and_preserve_positions(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let (target, _) = f.user("member").await;
    f.add(target).await;
    let before = f.right(target).await.0;
    let positions = snapshot(&f.pools.admin).await.as_array().unwrap()[1..].to_vec();
    let mut blocker = f.pools.admin.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,142))")
        .bind(f.org.to_string())
        .execute(&mut *blocker)
        .await
        .unwrap();
    for right in [true, false] {
        let response = tokio::time::timeout(
            Duration::from_secs(1),
            manager(&f.app, &f.token, f.channel, target, right),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(f.right(target).await, (before, right));
        assert_eq!(
            snapshot(&f.pools.admin).await.as_array().unwrap()[1..],
            positions
        );
    }
    blocker.rollback().await.unwrap();
    f.pools.app.close().await;
}
