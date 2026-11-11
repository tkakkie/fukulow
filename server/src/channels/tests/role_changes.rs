use super::management::{grant, mutation, snapshot};
use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

pub(super) async fn change(app: &Router, token: &str, target: Uuid, role: &str) -> Response {
    let organization = token.split_once('.').unwrap().0;
    request(
        app,
        "PATCH",
        &format!("/api/v1/orgs/{organization}/members/{target}/role"),
        token,
        json!({"role":role}),
    )
    .await
}

async fn private(app: &Router, token: &str, name: &str) -> Uuid {
    Uuid::parse_str(
        create(app, token, name, "private").await["id"]
            .as_str()
            .unwrap(),
    )
    .unwrap()
}

async fn all_state(pool: &PgPool) -> Value {
    let auth: Value = sqlx::query_scalar("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(u) ORDER BY organization_id,id) FROM users u),(SELECT jsonb_agg(to_jsonb(s) ORDER BY token_hash) FROM account_sessions s),(SELECT jsonb_agg(to_jsonb(c) ORDER BY organization_id,id) FROM channels c))")
        .fetch_one(pool).await.unwrap();
    json!([auth, snapshot(pool).await])
}

#[derive(Default)]
struct ObservedAccess {
    access: super::super::access::AccessChanges,
    calls: AtomicUsize,
}
impl auth::SubscriptionRecheck for ObservedAccess {
    fn check<'a>(
        &'a self,
        pool: &'a PgPool,
        scope: auth::SubscriptionScope,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), sqlx::Error>> + Send + 'a>>
    {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { auth::SubscriptionRecheck::check(&self.access, pool, scope).await })
    }
    fn failed(&self, _: auth::SubscriptionScope) {
        panic!("unexpected subscription failure");
    }
}

#[sqlx::test]
async fn role_demotion_is_atomic_across_private_channels_and_leaks_no_details(pool: PgPool) {
    for multiple in [false, true] {
        let state = AppState::for_test(pool.clone());
        let app = crate::app(state.clone());
        let observed = Arc::new(ObservedAccess::default());
        state
            .session_changes
            .set_subscription_recheck(observed.clone());
        let org = organization(&pool).await;
        let ot = member(&pool, org, Uuid::new_v4(), "owner").await;
        let target = Uuid::new_v4();
        let tt = member(&pool, org, target, "admin").await;
        let secret = private(&app, &tt, "Secret managed Channel").await;
        for role in ["member", "guest"] {
            let id = Uuid::new_v4();
            member(&pool, org, id, role).await;
            grant(&pool, org, secret, id).await;
        }
        if multiple {
            let companion = private(&app, &tt, "Another secret Channel").await;
            let other = Uuid::new_v4();
            member(&pool, org, other, "admin").await;
            grant(&pool, org, companion, other).await;
        }
        // Guest demotion would also delete the target's public Unread positions
        // and retire this subscription if the guard were late or non-atomic.
        let public = create(&app, &ot, "Public control", "public").await;
        let public = Uuid::parse_str(public["id"].as_str().unwrap()).unwrap();
        let message = request(
            &app, "POST", &format!("/api/v1/channels/{public}/messages"), &ot,
            json!({"client_message_id":Uuid::new_v4(),"body":"Unread control","topic_name":"Preserved Topic"}),
        ).await;
        assert_eq!(message.status(), StatusCode::CREATED);
        let watch = observed
            .access
            .subscribe(&pool, org, (target, 0), public)
            .await
            .unwrap()
            .unwrap();
        let hidden = request(
            &app,
            "GET",
            &format!("/api/v1/channels/{secret}/members"),
            &ot,
            Value::Null,
        )
        .await;
        assert_eq!(hidden.status(), StatusCode::NOT_FOUND);
        for role in ["member", "guest"] {
            let before = all_state(&pool).await;
            let response = change(&app, &ot, target, role).await;
            assert_eq!(response.status(), StatusCode::CONFLICT);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(
                body(response).await,
                json!({"error":"last_channel_manager"})
            );
            assert_eq!(all_state(&pool).await, before);
            assert_eq!(watch.status(), 0);
            assert_eq!(observed.calls.load(Ordering::SeqCst), 0);
        }
        // Once every Channel has another usable manager, the entire update succeeds.
        let replacement = Uuid::new_v4();
        member(&pool, org, replacement, "owner").await;
        grant(&pool, org, secret, replacement).await;
        assert_eq!(
            change(&app, &ot, target, "guest").await.status(),
            StatusCode::OK
        );
        assert_eq!(watch.status(), 1);
        assert_eq!(observed.calls.load(Ordering::SeqCst), 1);
    }
}

#[sqlx::test]
async fn role_demotion_counts_only_usable_scoped_managers_with_allowed_controls(pool: PgPool) {
    let app = router(&pool);
    let org = organization(&pool).await;
    let owner = Uuid::new_v4();
    let ot = member(&pool, org, owner, "owner").await;
    for stale in [false, true] {
        let target = Uuid::new_v4();
        let tt = member(&pool, org, target, "owner").await;
        let channel = private(&app, &tt, &format!("Usable managers {stale}")).await;
        let other = Uuid::new_v4();
        member(&pool, org, other, "admin").await;
        grant(&pool, org, channel, other).await;
        sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(other)
            .execute(&pool)
            .await
            .unwrap();
        if stale {
            sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(other)
                .execute(&pool)
                .await
                .unwrap();
        }
        // Same Member ids in another Organization must neither count as a
        // replacement manager nor be changed by this Organization's request.
        let foreign = organization(&pool).await;
        let ft = member(&pool, foreign, target, "owner").await;
        member(&pool, foreign, other, "admin").await;
        let fc = private(&app, &ft, "Foreign managed").await;
        grant(&pool, foreign, fc, other).await;
        assert_eq!(
            change(&app, &ot, target, "admin").await.status(),
            StatusCode::OK
        );
        let before = all_state(&pool).await;
        let response = change(&app, &ot, target, "member").await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            body(response).await,
            json!({"error":"last_channel_manager"})
        );
        assert_eq!(all_state(&pool).await, before);
        grant(&pool, org, channel, owner).await;
        assert_eq!(
            change(&app, &ot, target, "member").await.status(),
            StatusCode::OK
        );
        let role: String =
            sqlx::query_scalar("SELECT role FROM users WHERE organization_id=$1 AND id=$2")
                .bind(foreign)
                .bind(target)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(role, "owner");
        // A private Channel that already has no usable manager gains no rule.
        private(&app, &tt, &format!("Unmanaged from creation {stale}")).await;
        assert_eq!(
            change(&app, &ot, target, "guest").await.status(),
            StatusCode::OK
        );
    }
    let public_target = Uuid::new_v4();
    let pt = member(&pool, org, public_target, "admin").await;
    create(&app, &pt, "Public only manager", "public").await;
    assert_eq!(
        change(&app, &ot, public_target, "guest").await.status(),
        StatusCode::OK
    );
    // A stale target grant is not a manager even if the target is currently Admin.
    let stale = Uuid::new_v4();
    let st = member(&pool, org, stale, "admin").await;
    let sc = private(&app, &st, "Stale target").await;
    sqlx::query("UPDATE channel_members SET membership_revision=-1 WHERE organization_id=$1 AND channel_id=$2")
        .bind(org).bind(sc).execute(&pool).await.unwrap();
    assert_eq!(
        change(&app, &ot, stale, "guest").await.status(),
        StatusCode::OK
    );
}

async fn wait_for_lock(pool: &PgPool, pattern: &str, count: i64) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let waiting: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1")
                .bind(pattern).fetch_one(pool).await.unwrap();
            if waiting == count { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
}

#[sqlx::test]
async fn role_demotion_races_with_demotion_removal_and_leave_preserve_a_manager(pool: PgPool) {
    for operation in ["demote", "remove", "leave"] {
        for role_first in [false, true] {
            let app = router(&pool);
            let org = organization(&pool).await;
            let ot = member(&pool, org, Uuid::new_v4(), "owner").await;
            let a = Uuid::new_v4();
            let at = member(&pool, org, a, "admin").await;
            let b = Uuid::new_v4();
            let bt = member(&pool, org, b, "admin").await;
            let c = private(&app, &at, "Concurrent").await;
            grant(&pool, org, c, b).await;
            let reader = Uuid::new_v4();
            member(&pool, org, reader, "guest").await;
            grant(&pool, org, c, reader).await;
            let mut blocker = pool.begin().await.unwrap();
            auth::members::lock_organization(&mut blocker, org)
                .await
                .unwrap();
            let mut tasks = Vec::new();
            for is_role in [role_first, !role_first] {
                let app = app.clone();
                let ot = ot.clone();
                let at = at.clone();
                let bt = bt.clone();
                tasks.push(tokio::spawn(async move {
                    if is_role {
                        change(&app, &ot, b, "guest").await
                    } else if operation == "demote" {
                        change(&app, &ot, a, "member").await
                    } else {
                        mutation(
                            &app,
                            if operation == "leave" { &at } else { &bt },
                            c,
                            a,
                            false,
                        )
                        .await
                    }
                }));
                wait_for_lock(
                    &pool,
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
            assert!(first.status().is_success());
            let expected = if operation == "remove" && role_first {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::CONFLICT
            };
            assert_eq!(second.status(), expected);
            assert_eq!(
                body(second).await,
                json!({"error":if expected==StatusCode::CONFLICT {"last_channel_manager"} else {"forbidden"}})
            );
            let managers: i64 = sqlx::query_scalar("SELECT count(*) FROM channel_members cm JOIN users u ON u.organization_id=cm.organization_id AND u.id=cm.member_id AND u.membership_revision=cm.membership_revision WHERE cm.organization_id=$1 AND cm.channel_id=$2 AND u.deactivated_at IS NULL AND u.role IN ('owner','admin')")
                .bind(org).bind(c).fetch_one(&pool).await.unwrap();
            assert_eq!(managers, 1);
        }
    }
}

#[sqlx::test]
async fn role_demotion_locks_organization_then_channels_in_order_before_members(pool: PgPool) {
    let app = router(&pool);
    let org = organization(&pool).await;
    let target = Uuid::new_v4();
    let tt = member(&pool, org, target, "owner").await;
    let owner = Uuid::new_v4();
    let ot = member(&pool, org, owner, "owner").await;
    let mut channels = [
        private(&app, &tt, "Lock one").await,
        private(&app, &tt, "Lock two").await,
    ];
    channels.sort();
    for token in [tt, ot] {
        let mut blocker = pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM channels WHERE organization_id=$1 AND id=$2 FOR NO KEY UPDATE")
            .bind(org)
            .bind(channels[1])
            .execute(&mut *blocker)
            .await
            .unwrap();
        let pending = {
            let app = app.clone();
            tokio::spawn(async move { change(&app, &token, target, "member").await })
        };
        wait_for_lock(&pool, "SELECT c.id FROM channels%FOR NO KEY UPDATE OF c", 1).await;
        for (table, id) in [("organizations", org), ("channels", channels[0])] {
            let mut probe = pool.begin().await.unwrap();
            let key = if table == "organizations" {
                "organization_id"
            } else {
                "id"
            };
            let result = sqlx::query(&format!("SELECT {key} FROM {table} WHERE organization_id=$1 AND {key}=$2 FOR NO KEY UPDATE NOWAIT"))
                .bind(org).bind(id).execute(&mut *probe).await.unwrap_err();
            assert_eq!(
                result.as_database_error().unwrap().code().as_deref(),
                Some("55P03")
            );
            probe.rollback().await.unwrap();
        }
        let mut probe = pool.begin().await.unwrap();
        sqlx::query(
            "SELECT id FROM users WHERE organization_id=$1 AND id=ANY($2) FOR UPDATE NOWAIT",
        )
        .bind(org)
        .bind(&[owner, target][..])
        .execute(&mut *probe)
        .await
        .unwrap();
        probe.commit().await.unwrap();
        blocker.commit().await.unwrap();
        assert_eq!(pending.await.unwrap().status(), StatusCode::CONFLICT);
    }
}
