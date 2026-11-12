use super::*;

pub(super) async fn mutation(
    app: &Router,
    token: &str,
    channel: Uuid,
    target: Uuid,
    add: bool,
) -> Response {
    request(
        app,
        if add { "POST" } else { "DELETE" },
        &if add {
            format!("/api/v1/channels/{channel}/members")
        } else {
            format!("/api/v1/channels/{channel}/members/{target}")
        },
        token,
        json!({"member_id":target}),
    )
    .await
}
pub(super) async fn grant(pool: &PgPool, org: Uuid, channel: Uuid, target: Uuid) {
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
    )
    .bind(org)
    .bind(channel)
    .bind(target)
    .execute(pool)
    .await
    .unwrap();
}
pub(super) async fn snapshot(pool: &PgPool) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(c) ORDER BY organization_id,channel_id,member_id) FROM channel_members c),(SELECT jsonb_agg(to_jsonb(p) ORDER BY organization_id,channel_id,member_id) FROM channel_read_positions p),(SELECT jsonb_agg(to_jsonb(p) ORDER BY organization_id,channel_id,member_id,topic_id) FROM topic_read_positions p))").fetch_one(pool).await.unwrap()
}
async fn denied(
    pool: &PgPool,
    app: &Router,
    token: &str,
    channel: Uuid,
    target: Uuid,
    add: bool,
    (status, error): (StatusCode, &str),
) {
    let before = snapshot(pool).await;
    let response = mutation(app, token, channel, target, add).await;
    assert_eq!(response.status(), status);
    assert_eq!(body(response).await, json!({"error":error}));
    assert_eq!(snapshot(pool).await, before);
}

#[sqlx::test]
async fn foreign_organization_channel_member_endpoints_deny_without_changes_with_owner_controls(
    pool: PgPool,
) {
    let app = router(&pool);
    let org = organization(&pool).await;
    let foreign = organization(&pool).await;
    let owner = Uuid::new_v4();
    let token = member(&pool, org, owner, "owner").await;
    let foreign_token = member(&pool, foreign, owner, "owner").await;
    let target = Uuid::new_v4();
    member(&pool, org, target, "member").await;
    let channel = create(&app, &token, "Managed", "private").await;
    let channel = Uuid::parse_str(channel["id"].as_str().unwrap()).unwrap();
    let path = format!("/api/v1/orgs/{org}/channels/{channel}/members");
    for method in ["GET", "POST", "DELETE"] {
        let path = if method == "DELETE" {
            format!("{path}/{target}")
        } else {
            path.clone()
        };
        let input = json!({"member_id":target});
        let before = snapshot(&pool).await;
        let response = request(&app, method, &path, &foreign_token, input.clone()).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{method}");
        assert_eq!(
            body(response).await,
            json!({"error":"organization_unavailable"}),
            "{method}"
        );
        assert_eq!(snapshot(&pool).await, before, "{method}");
        let response = request(&app, method, &path, &token, input).await;
        assert_eq!(
            response.status(),
            if method == "GET" {
                StatusCode::OK
            } else {
                StatusCode::NO_CONTENT
            },
            "{method}"
        );
        if method == "GET" {
            assert_eq!(
                body(response).await,
                json!({"members":[{"id":owner,"name":"Member","role":"owner","manager":true}]})
            );
        }
        let granted: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3)")
            .bind(org).bind(channel).bind(target).fetch_one(&pool).await.unwrap();
        assert_eq!(granted, method == "POST", "{method}");
    }
}

#[sqlx::test]
async fn management_denial_matrix_and_idempotent_current_revision_grants(pool: PgPool) {
    let state = AppState::for_test(pool.clone());
    let app = crate::app(state.clone());
    let org = organization(&pool).await;
    let owner = Uuid::new_v4();
    let owner_token = member(&pool, org, owner, "owner").await;
    let private = create(&app, &owner_token, "Managed", "private").await;
    let channel = Uuid::parse_str(private["id"].as_str().unwrap()).unwrap();
    let target = Uuid::new_v4();
    let target_token = member(&pool, org, target, "member").await;
    for role in ["owner", "admin", "member", "guest"] {
        let id = Uuid::new_v4();
        let token = member(&pool, org, id, role).await;
        for add in [true, false] {
            denied(
                &pool,
                &app,
                &token,
                channel,
                target,
                add,
                (StatusCode::NOT_FOUND, "channel not found"),
            )
            .await;
        }
        let list = request(
            &app,
            "GET",
            &format!("/api/v1/channels/{channel}/members"),
            &token,
            Value::Null,
        )
        .await;
        assert_eq!(list.status(), StatusCode::NOT_FOUND);
        grant(&pool, org, channel, id).await;
        if role == "member" || role == "guest" {
            for add in [true, false] {
                denied(
                    &pool,
                    &app,
                    &token,
                    channel,
                    target,
                    add,
                    (StatusCode::FORBIDDEN, "forbidden"),
                )
                .await;
            }
        } else {
            assert_eq!(
                mutation(&app, &token, channel, target, true).await.status(),
                StatusCode::NO_CONTENT
            );
            let before = snapshot(&pool).await;
            assert_eq!(
                mutation(&app, &token, channel, target, true).await.status(),
                StatusCode::NO_CONTENT
            );
            assert_eq!(snapshot(&pool).await, before);
            assert_eq!(
                mutation(&app, &token, channel, target, false)
                    .await
                    .status(),
                StatusCode::NO_CONTENT
            );
            assert_eq!(
                mutation(&app, &token, channel, target, false)
                    .await
                    .status(),
                StatusCode::NO_CONTENT
            );
        }
        let listed = body(
            request(
                &app,
                "GET",
                &format!("/api/v1/channels/{channel}/members"),
                &token,
                Value::Null,
            )
            .await,
        )
        .await;
        assert!(listed["members"].as_array().unwrap().iter().all(|m| {
            m.as_object()
                .unwrap()
                .keys()
                .all(|k| ["id", "name", "role", "manager"].contains(&k.as_str()))
        }));
        assert_eq!(
            mutation(&app, &token, channel, id, false).await.status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            mutation(&app, &token, channel, id, false).await.status(),
            StatusCode::NOT_FOUND
        );
    }
    let foreign_org = organization(&pool).await;
    let foreign = Uuid::new_v4();
    let foreign_token = member(&pool, foreign_org, foreign, "owner").await;
    let foreign_channel = create(&app, &foreign_token, "Foreign", "public").await;
    let foreign_channel = Uuid::parse_str(foreign_channel["id"].as_str().unwrap()).unwrap();
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(target)
        .execute(&pool)
        .await
        .unwrap();
    for id in [Uuid::new_v4(), foreign, target] {
        for add in [true, false] {
            denied(
                &pool,
                &app,
                &owner_token,
                channel,
                id,
                add,
                (StatusCode::NOT_FOUND, "member_not_found"),
            )
            .await;
        }
    }
    for add in [true, false] {
        denied(
            &pool,
            &app,
            &owner_token,
            foreign_channel,
            target,
            add,
            (StatusCode::NOT_FOUND, "channel not found"),
        )
        .await;
    }
    grant(&pool, org, channel, target).await;
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(target)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/v1/channels/{channel}/members"),
            &target_token,
            Value::Null
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        mutation(&app, &owner_token, channel, target, true)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/v1/channels/{channel}/members"),
            &target_token,
            Value::Null
        )
        .await
        .status(),
        StatusCode::OK
    );
}

#[sqlx::test]
async fn management_rechecks_demoted_deactivated_stale_and_removed_actors(pool: PgPool) {
    for loss in ["demoted", "deactivated", "stale", "removed"] {
        for add in [true, false] {
            let state = AppState::for_test(pool.clone());
            let app = crate::app(state.clone());
            let org = organization(&pool).await;
            let owner = Uuid::new_v4();
            let token = member(&pool, org, owner, "owner").await;
            let admin = Uuid::new_v4();
            let admin_token = member(&pool, org, admin, "admin").await;
            let target = Uuid::new_v4();
            member(&pool, org, target, "member").await;
            let channel = create(&app, &token, "Private", "private").await;
            let channel = Uuid::parse_str(channel["id"].as_str().unwrap()).unwrap();
            grant(&pool, org, channel, admin).await;
            grant(&pool, org, channel, target).await;
            let auth = extract_auth(state.clone(), &admin_token).await;
            match loss {
                "demoted" => {
                    sqlx::query(
                        "UPDATE users SET role='member' WHERE organization_id=$1 AND id=$2",
                    )
                    .bind(org)
                    .bind(admin)
                    .execute(&pool)
                    .await
                    .unwrap();
                }
                "removed" => {
                    assert_eq!(
                        mutation(&app, &token, channel, admin, false).await.status(),
                        StatusCode::NO_CONTENT
                    );
                }
                _ => {
                    sqlx::query(
                        "UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2",
                    )
                    .bind(org)
                    .bind(admin)
                    .execute(&pool)
                    .await
                    .unwrap();
                    if loss == "stale" {
                        sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2").bind(org).bind(admin).execute(&pool).await.unwrap();
                    }
                }
            }
            let before = snapshot(&pool).await;
            let error = super::super::members::mutate(&state, &auth, channel, target, add)
                .await
                .unwrap_err()
                .into_response();
            assert_eq!(
                error.status(),
                if loss == "demoted" {
                    StatusCode::FORBIDDEN
                } else {
                    StatusCode::NOT_FOUND
                }
            );
            assert_eq!(snapshot(&pool).await, before);
        }
    }
}

#[sqlx::test]
async fn private_last_manager_last_grant_and_concurrent_removals_are_serialized(pool: PgPool) {
    for leave in [false, true] {
        let app = router(&pool);
        let org = organization(&pool).await;
        let a = Uuid::new_v4();
        let at = member(&pool, org, a, "admin").await;
        let b = Uuid::new_v4();
        let bt = member(&pool, org, b, "admin").await;
        let m = Uuid::new_v4();
        member(&pool, org, m, "member").await;
        let g = Uuid::new_v4();
        member(&pool, org, g, "guest").await;
        let c = create(&app, &at, "Managed", "private").await;
        let c = Uuid::parse_str(c["id"].as_str().unwrap()).unwrap();
        // Exercise the pre-#311 Role-only manager protection.
        sqlx::query(
            "UPDATE channel_members SET manager=false WHERE organization_id=$1 AND channel_id=$2",
        )
        .bind(org)
        .bind(c)
        .execute(&pool)
        .await
        .unwrap();
        for id in [b, m, g] {
            grant(&pool, org, c, id).await;
        }
        let (ar, br) = tokio::join!(
            mutation(&app, &at, c, if leave { a } else { b }, false),
            mutation(&app, &bt, c, if leave { b } else { a }, false)
        );
        let statuses = [ar.status(), br.status()];
        assert_eq!(
            statuses
                .iter()
                .filter(|s| **s == StatusCode::NO_CONTENT)
                .count(),
            1
        );
        let (remaining, token) =
            if mutation(&app, &at, c, m, true).await.status() == StatusCode::NO_CONTENT {
                (a, &at)
            } else {
                (b, &bt)
            };
        denied(
            &pool,
            &app,
            token,
            c,
            remaining,
            false,
            (StatusCode::CONFLICT, "last_channel_manager"),
        )
        .await;
        let owner_token = member(&pool, org, Uuid::new_v4(), "owner").await;
        let before = snapshot(&pool).await;
        let response = super::role_changes::change(&app, &owner_token, remaining, "member").await;
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            body(response).await,
            json!({"error":"last_channel_manager"})
        );
        assert_eq!(snapshot(&pool).await, before);
    }
}

#[sqlx::test]
async fn deactivated_and_stale_managers_never_count_as_usable(pool: PgPool) {
    for stale in [false, true] {
        let app = router(&pool);
        let org = organization(&pool).await;
        let a = Uuid::new_v4();
        let at = member(&pool, org, a, "admin").await;
        let b = Uuid::new_v4();
        member(&pool, org, b, "admin").await;
        let m = Uuid::new_v4();
        member(&pool, org, m, "member").await;
        let c = create(&app, &at, "Managed", "private").await;
        let c = Uuid::parse_str(c["id"].as_str().unwrap()).unwrap();
        grant(&pool, org, c, b).await;
        grant(&pool, org, c, m).await;
        sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(b)
            .execute(&pool)
            .await
            .unwrap();
        if stale {
            sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(b)
                .execute(&pool)
                .await
                .unwrap();
        }
        denied(
            &pool,
            &app,
            &at,
            c,
            a,
            false,
            (StatusCode::CONFLICT, "last_channel_manager"),
        )
        .await;
        assert_eq!(
            mutation(&app, &at, c, b, true).await.status(),
            if stale {
                StatusCode::NO_CONTENT
            } else {
                StatusCode::NOT_FOUND
            }
        );
        if stale {
            assert_eq!(
                mutation(&app, &at, c, a, false).await.status(),
                StatusCode::NO_CONTENT
            );
        }
    }
}

#[sqlx::test]
async fn unmanaged_guest_leave_succeeds_and_last_grant_is_protected(pool: PgPool) {
    let app = router(&pool);
    let org = organization(&pool).await;
    let m = Uuid::new_v4();
    let mt = member(&pool, org, m, "member").await;
    let g = Uuid::new_v4();
    let gt = member(&pool, org, g, "guest").await;
    let c = create(&app, &mt, "Unmanaged", "private").await;
    let c = Uuid::parse_str(c["id"].as_str().unwrap()).unwrap();
    // Existing unmanaged Channels receive no backfill in #311.
    sqlx::query(
        "UPDATE channel_members SET manager=false WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(org)
    .bind(c)
    .execute(&pool)
    .await
    .unwrap();
    grant(&pool, org, c, g).await;
    assert_eq!(
        mutation(&app, &gt, c, g, false).await.status(),
        StatusCode::NO_CONTENT
    );
    grant(&pool, org, c, g).await;
    assert_eq!(
        mutation(&app, &mt, c, m, false).await.status(),
        StatusCode::NO_CONTENT
    );
    denied(
        &pool,
        &app,
        &gt,
        c,
        g,
        false,
        (StatusCode::CONFLICT, "last_channel_grant"),
    )
    .await;
}

#[sqlx::test]
async fn self_leave_hides_inaccessible_existence_and_cleans_stale_grants(pool: PgPool) {
    let app = router(&pool);
    let org = organization(&pool).await;
    let owner = Uuid::new_v4();
    let ot = member(&pool, org, owner, "owner").await;
    let c = create(&app, &ot, "Private", "private").await;
    let c = Uuid::parse_str(c["id"].as_str().unwrap()).unwrap();
    // An orphaned stale grant must be removable even with no usable grants.
    sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2")
        .bind(org)
        .bind(c)
        .execute(&pool)
        .await
        .unwrap();
    for role in ["owner", "admin", "member", "guest"] {
        let id = Uuid::new_v4();
        let token = member(&pool, org, id, role).await;
        let missing = mutation(&app, &token, Uuid::new_v4(), id, false).await;
        let hidden = mutation(&app, &token, c, id, false).await;
        assert_eq!(hidden.status(), missing.status());
        assert_eq!(hidden.status(), StatusCode::NOT_FOUND);
        assert_eq!(body(hidden).await, body(missing).await);
        grant(&pool, org, c, id).await;
        sqlx::query("UPDATE channel_members SET membership_revision=membership_revision-1 WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
            .bind(org).bind(c).bind(id).execute(&pool).await.unwrap();
        assert_eq!(
            mutation(&app, &token, c, id, false).await.status(),
            StatusCode::NO_CONTENT
        );
        let remains: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3)")
            .bind(org).bind(c).bind(id).fetch_one(&pool).await.unwrap();
        assert!(!remains);
        assert_eq!(
            mutation(&app, &token, c, id, false).await.status(),
            StatusCode::NOT_FOUND
        );
    }
    let public = create(&app, &ot, "Public", "public").await;
    let public = Uuid::parse_str(public["id"].as_str().unwrap()).unwrap();
    assert_eq!(
        mutation(&app, &ot, public, owner, false).await.status(),
        StatusCode::NO_CONTENT
    );
}

#[sqlx::test]
async fn mutation_locks_channel_before_actor_member(pool: PgPool) {
    let app = router(&pool);
    let org = organization(&pool).await;
    let owner = Uuid::new_v4();
    let token = member(&pool, org, owner, "owner").await;
    let c = create(&app, &token, "Lock order", "public").await;
    let c = Uuid::parse_str(c["id"].as_str().unwrap()).unwrap();
    for add in [true, false] {
        let mut channel_lock = pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM channels WHERE organization_id=$1 AND id=$2 FOR NO KEY UPDATE")
            .bind(org)
            .bind(c)
            .execute(&mut *channel_lock)
            .await
            .unwrap();
        let mutation = {
            let app = app.clone();
            let token = token.clone();
            tokio::spawn(async move { mutation(&app, &token, c, owner, add).await })
        };
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT visibility=%FOR NO KEY UPDATE')")
                    .fetch_one(&pool).await.unwrap();
                if waiting { break; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        // A #231 transaction holding Channel before Member must be able to
        // finish: the waiting mutation must not already hold its actor Member.
        let mut member_lock = pool.begin().await.unwrap();
        sqlx::query("SET LOCAL lock_timeout='200ms'")
            .execute(&mut *member_lock)
            .await
            .unwrap();
        sqlx::query("SELECT id FROM users WHERE organization_id=$1 AND id=$2 FOR UPDATE")
            .bind(org)
            .bind(owner)
            .execute(&mut *member_lock)
            .await
            .unwrap();
        member_lock.commit().await.unwrap();
        channel_lock.commit().await.unwrap();
        assert_eq!(mutation.await.unwrap().status(), StatusCode::NO_CONTENT);
    }
}

#[sqlx::test]
async fn noop_grant_mutations_skip_subscription_rechecks(pool: PgPool) {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    #[derive(Default)]
    struct Counter(AtomicUsize);
    impl auth::SubscriptionRecheck for Counter {
        fn check<'a>(
            &'a self,
            _: &'a PgPool,
            _: auth::SubscriptionScope,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), sqlx::Error>> + Send + 'a>>
        {
            self.0.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
        fn failed(&self, _: auth::SubscriptionScope) {
            panic!("unexpected failed check");
        }
    }
    let state = AppState::for_test(pool.clone());
    let count = Arc::new(Counter::default());
    let app = crate::app(state.clone());
    state
        .session_changes
        .set_subscription_recheck(count.clone());
    let org = organization(&pool).await;
    let owner = Uuid::new_v4();
    let token = member(&pool, org, owner, "owner").await;
    let c = create(&app, &token, "No-op", "public").await;
    let c = Uuid::parse_str(c["id"].as_str().unwrap()).unwrap();
    for (add, expected) in [(false, 0), (true, 1), (true, 1), (false, 2), (false, 2)] {
        assert_eq!(
            mutation(&app, &token, c, owner, add).await.status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(count.0.load(Ordering::SeqCst), expected);
    }
}

#[sqlx::test]
async fn fast_subscription_rechecks_and_failures_are_scoped(pool: PgPool) {
    let access = super::super::access::AccessChanges::default();
    let state = AppState::for_test(pool.clone());
    let app = crate::app(state.clone());
    let org = organization(&pool).await;
    let owner = Uuid::new_v4();
    let other = Uuid::new_v4();
    let ot = member(&pool, org, owner, "owner").await;
    member(&pool, org, other, "member").await;
    let foreign = organization(&pool).await;
    let ft = member(&pool, foreign, owner, "owner").await;
    let mut keys = Vec::new();
    for (org, token, name) in [
        (org, &ot, "First"),
        (org, &ot, "Second"),
        (foreign, &ft, "Foreign"),
    ] {
        let c = create(&app, token, name, "private").await;
        let c = Uuid::parse_str(c["id"].as_str().unwrap()).unwrap();
        keys.push((org, owner, c));
        if name == "First" {
            grant(&pool, org, c, other).await;
            keys.push((org, other, c));
        }
    }
    let mut watches = Vec::new();
    let mut failures = Vec::new();
    let fail_registry = super::super::access::AccessChanges::default();
    state
        .session_changes
        .set_subscription_recheck(std::sync::Arc::new(fail_registry.clone()));
    for &(org, member, channel) in &keys {
        watches.push(
            access
                .subscribe(&pool, org, (member, 0), channel)
                .await
                .unwrap()
                .unwrap(),
        );
        failures.push(
            fail_registry
                .subscribe(&pool, org, (member, 0), channel)
                .await
                .unwrap()
                .unwrap(),
        );
    }
    // Simulate dropped fast signals, including in another Organization.
    sqlx::query("DELETE FROM channel_members")
        .execute(&pool)
        .await
        .unwrap();
    use auth::{SubscriptionRecheck, SubscriptionScope};
    access
        .check(&pool, SubscriptionScope::Channel(org, keys[0].2))
        .await
        .unwrap();
    assert_eq!(
        watches.iter().map(|w| w.status()).collect::<Vec<_>>(),
        vec![1, 1, 0, 0]
    );
    access
        .check(&pool, SubscriptionScope::Member(org, owner))
        .await
        .unwrap();
    assert_eq!(
        watches.iter().map(|w| w.status()).collect::<Vec<_>>(),
        vec![1, 1, 1, 0]
    );
    pool.close().await;
    state
        .session_changes
        .recheck_subscriptions(&pool, SubscriptionScope::Member(org, owner))
        .await;
    assert_eq!(
        failures.iter().map(|w| w.status()).collect::<Vec<_>>(),
        vec![2, 0, 2, 0]
    );
    state
        .session_changes
        .recheck_subscriptions(&pool, SubscriptionScope::Channel(org, keys[0].2))
        .await;
    assert_eq!(
        failures.iter().map(|w| w.status()).collect::<Vec<_>>(),
        vec![2, 2, 2, 0]
    );
}
