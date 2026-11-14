use super::*;
use std::time::Duration;

mod concurrency;

pub(super) async fn deactivate(app: &Router, token: &str, target: Uuid) -> Response {
    let org = token.split_once('.').unwrap().0;
    request(
        app,
        "POST",
        &format!("/api/v1/orgs/{org}/members/{target}/deactivate"),
        token,
        Value::Null,
    )
    .await
}

async fn all_state(pool: &PgPool) -> Value {
    let auth: Value = sqlx::query_scalar("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(u) ORDER BY organization_id,id) FROM users u),(SELECT jsonb_agg(to_jsonb(s) ORDER BY token_hash) FROM account_sessions s),(SELECT jsonb_agg(to_jsonb(o) ORDER BY organization_id) FROM organizations o))")
        .fetch_one(pool).await.unwrap();
    json!([auth, snapshot(pool).await])
}

async fn denial(pool: PgPool, case: &str) {
    let f = Fixture::new(pool).await;
    let (owner, ot) = f.user("owner").await;
    let (admin, at) = f.user("admin").await;
    let (guest, gt) = f.user("guest").await;
    f.add(owner).await;
    f.add(admin).await;
    f.add(guest).await;
    let (mut actor, mut target, mut status, mut error) =
        (ot.clone(), f.creator, StatusCode::FORBIDDEN, "forbidden");
    match case {
        "self_owner" | "self_last_owner" => target = owner,
        "self_admin" => {
            actor = at.clone();
            target = admin;
        }
        "member" => actor = f.token.clone(),
        "guest" => actor = gt,
        "admin_owner" => {
            actor = at;
            target = owner;
        }
        "unavailable" => {
            sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
                .bind(f.org)
                .bind(admin)
                .execute(&f.pools.admin)
                .await
                .unwrap();
            actor = at;
            status = StatusCode::NOT_FOUND;
            error = "organization_unavailable";
        }
        "other_org" => {
            let foreign = organization(&f.pools.admin).await;
            actor = member(&f.pools.admin, foreign, Uuid::new_v4(), "owner").await;
            // The token itself identifies a Session; use the caller's actual credential
            // against this Organization rather than changing its hash.
            let before = all_state(&f.pools.admin).await;
            let response = request(
                &f.app,
                "POST",
                &format!("/api/v1/orgs/{}/members/{target}/deactivate", f.org),
                &actor,
                Value::Null,
            )
            .await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert_eq!(
                body(response).await,
                json!({"error":"organization_unavailable"})
            );
            assert_eq!(all_state(&f.pools.admin).await, before);
            f.pools.app.close().await;
            return;
        }
        "foreign_target" | "unknown" | "inactive" => {
            status = StatusCode::NOT_FOUND;
            error = "member_not_found";
            if case == "foreign_target" {
                let foreign = organization(&f.pools.admin).await;
                target = Uuid::new_v4();
                member(&f.pools.admin, foreign, target, "member").await;
            } else if case == "unknown" {
                target = Uuid::new_v4();
            } else {
                sqlx::query(
                    "UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2",
                )
                .bind(f.org)
                .bind(f.creator)
                .execute(&f.pools.admin)
                .await
                .unwrap();
            }
        }
        "last_role_manager" | "last_right_manager" => {
            status = StatusCode::CONFLICT;
            error = "last_channel_manager";
            // Remove the replacement managers. A right-holding Member or an
            // Owner/Admin without the right is then the only usable manager.
            for id in [owner, admin] {
                sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                    .bind(f.org).bind(f.channel).bind(id).execute(&f.pools.admin).await.unwrap();
            }
            if case == "last_role_manager" {
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
            }
        }
        _ => unreachable!(),
    }
    if case == "self_owner" {
        f.user("owner").await;
    }
    let watch = f
        .observed
        .access
        .subscribe(&f.pools.app, f.org, (owner, 0), f.channel)
        .await
        .unwrap();
    let before = all_state(&f.pools.admin).await;
    let calls = f.observed.calls.load(Ordering::SeqCst);
    let response = deactivate(&f.app, &actor, target).await;
    assert_eq!(response.status(), status, "{case}");
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(body(response).await, json!({"error":error}), "{case}");
    assert_eq!(all_state(&f.pools.admin).await, before, "{case}");
    if let Some(watch) = watch {
        assert_eq!(watch.status(), 0);
    }
    assert_eq!(f.observed.calls.load(Ordering::SeqCst), calls);
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn deactivation_authentication_precedes_membership_and_target(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let before = all_state(&f.pools.admin).await;
    let response = f
        .app
        .clone()
        .oneshot(
            Request::post(format!(
                "/api/v1/orgs/{}/members/{}/deactivate",
                f.org, f.creator
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(body(response).await, json!({"error":"invalid credentials"}));
    assert_eq!(all_state(&f.pools.admin).await, before);
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn deactivation_role_matrix_and_repeat_requests_use_member_ids(pool: PgPool) {
    for actor_role in ["owner", "admin"] {
        let f = Fixture::new(pool.clone()).await;
        let (_, token) = f.user(actor_role).await;
        for target_role in ["owner", "admin", "member", "guest"] {
            if actor_role == "admin" && target_role == "owner" {
                continue;
            }
            let (target, tt) = f.user(target_role).await;
            let account: Uuid = sqlx::query_scalar(
                "SELECT account_id FROM users WHERE organization_id=$1 AND id=$2",
            )
            .bind(f.org)
            .bind(target)
            .fetch_one(&f.pools.admin)
            .await
            .unwrap();
            assert_ne!(target, account);
            let invalid = deactivate(&f.app, &token, account).await;
            assert_eq!(invalid.status(), StatusCode::NOT_FOUND);
            assert_eq!(body(invalid).await, json!({"error":"member_not_found"}));
            let response = deactivate(&f.app, &token, target).await;
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert!(
                to_bytes(response.into_body(), 1024)
                    .await
                    .unwrap()
                    .is_empty()
            );
            let (inactive,revision):(bool,i64) = sqlx::query_as("SELECT deactivated_at IS NOT NULL,membership_revision FROM users WHERE organization_id=$1 AND id=$2")
                .bind(f.org).bind(target).fetch_one(&f.pools.admin).await.unwrap();
            assert_eq!((inactive, revision), (true, 1));
            let response = deactivate(&f.app, &token, target).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert_eq!(body(response).await, json!({"error":"member_not_found"}));
            for path in [
                "me".to_owned(),
                "channels".into(),
                format!("channels/{}/messages?after_seq=0", f.channel),
            ] {
                let response = request(
                    &f.app,
                    "GET",
                    &format!("/api/v1/orgs/{}/{path}", f.org),
                    &tt,
                    Value::Null,
                )
                .await;
                assert_eq!(response.status(), StatusCode::NOT_FOUND);
                assert_eq!(
                    body(response).await,
                    json!({"error":"organization_unavailable"})
                );
            }
        }
        f.pools.app.close().await;
    }
}

#[fukulow_test::test]
async fn deactivation_manager_controls_and_public_unmanaged_exceptions(pool: PgPool) {
    for backup_role in ["owner", "admin", "member"] {
        for actor_role in ["owner", "admin"] {
            let f = Fixture::new(pool.clone()).await;
            let (_, ot) = f.user(actor_role).await;
            let (backup, _) = f.user(backup_role).await;
            f.add(backup).await;
            if backup_role == "member" {
                assert_eq!(
                    manager(&f.app, &f.token, f.channel, backup, true)
                        .await
                        .status(),
                    StatusCode::NO_CONTENT
                );
            }
            assert_eq!(
                deactivate(&f.app, &ot, f.creator).await.status(),
                StatusCode::NO_CONTENT
            );
            f.pools.app.close().await;
        }
    }
    let f = Fixture::new(pool).await;
    let (_, ot) = f.user("owner").await;
    // Already unmanaged private Channels and public Channels are exceptions.
    sqlx::query(
        "UPDATE channel_members SET manager=false WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(f.org)
    .bind(f.channel)
    .execute(&f.pools.admin)
    .await
    .unwrap();
    create(&f.app, &f.token, "Public exception", "public").await;
    assert_eq!(
        deactivate(&f.app, &ot, f.creator).await.status(),
        StatusCode::NO_CONTENT
    );
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn deactivation_denies_self_owner_unchanged(pool: PgPool) {
    denial(pool, "self_owner").await;
}

#[fukulow_test::test]
async fn deactivation_denies_self_admin_unchanged(pool: PgPool) {
    denial(pool, "self_admin").await;
}

#[fukulow_test::test]
async fn deactivation_denies_self_last_owner_unchanged(pool: PgPool) {
    denial(pool, "self_last_owner").await;
}

#[fukulow_test::test]
async fn deactivation_denies_member_unchanged(pool: PgPool) {
    denial(pool, "member").await;
}

#[fukulow_test::test]
async fn deactivation_denies_guest_unchanged(pool: PgPool) {
    denial(pool, "guest").await;
}

#[fukulow_test::test]
async fn deactivation_denies_admin_owner_unchanged(pool: PgPool) {
    denial(pool, "admin_owner").await;
}

#[fukulow_test::test]
async fn deactivation_denies_unavailable_unchanged(pool: PgPool) {
    denial(pool, "unavailable").await;
}

#[fukulow_test::test]
async fn deactivation_denies_other_org_unchanged(pool: PgPool) {
    denial(pool, "other_org").await;
}

#[fukulow_test::test]
async fn deactivation_denies_foreign_target_unchanged(pool: PgPool) {
    denial(pool, "foreign_target").await;
}

#[fukulow_test::test]
async fn deactivation_denies_unknown_unchanged(pool: PgPool) {
    denial(pool, "unknown").await;
}

#[fukulow_test::test]
async fn deactivation_denies_inactive_unchanged(pool: PgPool) {
    denial(pool, "inactive").await;
}

#[fukulow_test::test]
async fn deactivation_denies_last_role_manager_unchanged(pool: PgPool) {
    denial(pool, "last_role_manager").await;
}

#[fukulow_test::test]
async fn deactivation_denies_last_right_manager_unchanged(pool: PgPool) {
    denial(pool, "last_right_manager").await;
}

#[fukulow_test::test]
async fn deactivation_is_atomic_across_private_channels(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let (owner, ot) = f.user("owner").await;
    f.add(owner).await;
    create(&f.app, &f.token, "Last manager elsewhere", "private").await;
    let before = all_state(&f.pools.admin).await;
    let response = deactivate(&f.app, &ot, f.creator).await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        body(response).await,
        json!({"error":"last_channel_manager"})
    );
    assert_eq!(all_state(&f.pools.admin).await, before);
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn deactivation_base_denial_precedes_target_lookup(pool: PgPool) {
    let f = Fixture::new(pool).await;
    for token in [f.token.clone(), f.user("guest").await.1] {
        let before = all_state(&f.pools.admin).await;
        let response = deactivate(&f.app, &token, Uuid::new_v4()).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(body(response).await, json!({"error":"forbidden"}));
        assert_eq!(all_state(&f.pools.admin).await, before);
    }
    let (_, at) = f.user("admin").await;
    let response = deactivate(&f.app, &at, Uuid::new_v4()).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(body(response).await, json!({"error":"member_not_found"}));
    f.pools.app.close().await;
}
