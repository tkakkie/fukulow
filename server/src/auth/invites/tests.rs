use super::*;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::Request,
};
use serde_json::{Value, json};
use tower::ServiceExt;

mod stale_session;
mod text_input;

async fn org(pool: &sqlx::PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (organization_id,name) VALUES ($1,'Test')")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    id
}
async fn account(pool: &sqlx::PgPool, org: Uuid, role: Role) -> (Uuid, Uuid, String, String) {
    let id = Uuid::new_v4();
    let member = Uuid::new_v4();
    let email = format!("{id}@example.invalid");
    sqlx::query("INSERT INTO accounts (id,email,password_hash) VALUES ($1,$2,'unused')")
        .bind(id)
        .bind(&email)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO users (organization_id,id,account_id,name,role) VALUES ($1,$2,$3,'Test',$4)",
    )
    .bind(org)
    .bind(member)
    .bind(id)
    .bind(role)
    .execute(pool)
    .await
    .unwrap();
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    sqlx::query("INSERT INTO account_sessions (token_hash,account_id) VALUES ($1,$2)")
        .bind(Sha256::digest(token.as_bytes()).to_vec())
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    (id, member, email, token)
}
async fn req(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    input: Value,
) -> Response {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        req = req.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    app.clone()
        .oneshot(req.body(Body::from(input.to_string())).unwrap())
        .await
        .unwrap()
}
async fn body(r: Response) -> Value {
    assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
    serde_json::from_slice(&to_bytes(r.into_body(), 65536).await.unwrap()).unwrap()
}
async fn invite(app: &Router, org: Uuid, owner: &str, email: &str, role: Role) -> Value {
    let r = req(
        app,
        "POST",
        &format!("/api/v1/orgs/{org}/invites"),
        Some(owner),
        json!({"email":email,"role":role}),
    )
    .await;
    assert_eq!(r.status(), StatusCode::CREATED);
    body(r).await
}
fn accept_input(invite: &Value, email: &str) -> Value {
    json!({"token":invite["token"],"email":email,"name":"Accepted"})
}

async fn assert_issuer_denied(
    app: &Router,
    pool: &sqlx::PgPool,
    org: Uuid,
    token: Option<&str>,
    input: Value,
) {
    let r = req(
        app,
        "POST",
        &format!("/api/v1/orgs/{org}/invites/accept"),
        token,
        input,
    )
    .await;
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    assert_eq!(body(r).await["error"], "invite_issuer_unauthorized");
    let consumed: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM invites WHERE organization_id=$1 AND accepted_at IS NOT NULL",
    )
    .bind(org)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(consumed, 0);
}

#[sqlx::test]
async fn invite_acceptance_denies_demoted_issuer_for_invited_role(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let (_, _, _, owner) = account(&pool, org, Role::Owner).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    for (initial, invited, current) in [
        (Role::Admin, Role::Admin, Role::Member),
        (Role::Owner, Role::Owner, Role::Admin),
    ] {
        let (_, issuer, _, token) = account(&pool, org, initial).await;
        let email = format!("{issuer}@new.invalid");
        let i = invite(&app, org, &token, &email, invited).await;
        let created_by: Uuid =
            sqlx::query_scalar("SELECT created_by FROM invites WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(i["id"].as_str().unwrap().parse::<Uuid>().unwrap())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(created_by, issuer);
        let r = req(
            &app,
            "PATCH",
            &format!("/api/v1/orgs/{org}/members/{issuer}/role"),
            Some(&owner),
            json!({"role":current}),
        )
        .await;
        assert_eq!(r.status(), StatusCode::OK);
        let mut input = accept_input(&i, &email);
        input["password"] = json!("test password with enough characters");
        assert_issuer_denied(&app, &pool, org, None, input).await;
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM accounts WHERE email=$1)")
                .bind(email)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(!exists);
    }
}

#[sqlx::test]
async fn invite_acceptance_denies_deactivated_issuer(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let other = org_fn(&pool).await;
    let (issuer, _, _, admin) = account(&pool, org, Role::Admin).await;
    let (target, _, email, token) = account(&pool, other, Role::Member).await;
    let state = AppState::for_test(pool.clone()).await;
    let app = crate::app(state.clone());
    let i = invite(&app, org, &admin, &email, Role::Admin).await;
    deactivate_member(&state, org, issuer).await.unwrap();
    assert_issuer_denied(&app, &pool, org, Some(&token), accept_input(&i, &email)).await;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM users WHERE organization_id=$1 AND account_id=$2)",
    )
    .bind(org)
    .bind(target)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!exists);
}

#[sqlx::test]
async fn invite_acceptance_denies_deactivated_issuer_self_reactivation(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let (issuer, member, email, token) = account(&pool, org, Role::Admin).await;
    let state = AppState::for_test(pool.clone()).await;
    let app = crate::app(state.clone());
    let i = invite(&app, org, &token, &email, Role::Admin).await;
    deactivate_member(&state, org, issuer).await.unwrap();
    assert_issuer_denied(&app, &pool, org, Some(&token), accept_input(&i, &email)).await;
    let inactive: bool = sqlx::query_scalar(
        "SELECT deactivated_at IS NOT NULL FROM users WHERE organization_id=$1 AND id=$2",
    )
    .bind(org)
    .bind(member)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(inactive);
}

#[sqlx::test]
async fn invite_acceptance_allows_currently_authorized_issuer(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let (_, _, _, admin) = account(&pool, org, Role::Admin).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    let email = "authorized@example.invalid";
    let i = invite(&app, org, &admin, email, Role::Admin).await;
    let mut input = accept_input(&i, email);
    input["password"] = json!("test password with enough characters");
    let r = req(
        &app,
        "POST",
        &format!("/api/v1/orgs/{org}/invites/accept"),
        None,
        input,
    )
    .await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(body(r).await["member"]["role"], "admin");
}

#[sqlx::test]
async fn invite_acceptance_rechecks_issuer_after_waiting_for_organization_lock(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let other = org_fn(&pool).await;
    let (_, foreign_member, email, recipient) = account(&pool, other, Role::Member).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    for deactivate in [false, true] {
        let (_, issuer, _, token) = account(&pool, org, Role::Admin).await;
        let i = invite(&app, org, &token, &email, Role::Admin).await;
        let error =
            sqlx::query("UPDATE invites SET created_by=$3 WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(i["id"].as_str().unwrap().parse::<Uuid>().unwrap())
                .bind(foreign_member)
                .execute(&pool)
                .await
                .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23503")
        );
        let mut tx = pool.begin().await.unwrap();
        members::lock_organization(&mut tx, org).await.unwrap();
        sqlx::query("UPDATE users SET role='member',deactivated_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END WHERE organization_id=$1 AND id=$2")
            .bind(org).bind(issuer).bind(deactivate).execute(&mut *tx).await.unwrap();
        let task = tokio::spawn({
            let app = app.clone();
            let pool = pool.clone();
            let recipient = recipient.clone();
            let input = accept_input(&i, &email);
            async move { assert_issuer_denied(&app, &pool, org, Some(&recipient), input).await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT organization_id FROM organizations%')")
                    .fetch_one(&pool).await.unwrap();
                if waiting { break; }
                tokio::task::yield_now().await;
            }
        }).await.unwrap();
        tx.commit().await.unwrap();
        task.await.unwrap();
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE organization_id=$1 AND account_id=(SELECT account_id FROM users WHERE organization_id=$2 AND id=$3)")
        .bind(org).bind(other).bind(foreign_member).fetch_one(&pool).await.unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test]
async fn invite_acceptance_allows_demoted_issuer_with_authority_for_invited_role(
    pool: sqlx::PgPool,
) {
    let org = org(&pool).await;
    let other = org_fn(&pool).await;
    let (_, _, _, owner) = account(&pool, org, Role::Owner).await;
    let (_, issuer, _, token) = account(&pool, org, Role::Owner).await;
    let (_, _, email, recipient) = account(&pool, other, Role::Member).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    let i = invite(&app, org, &token, &email, Role::Admin).await;
    let r = req(
        &app,
        "PATCH",
        &format!("/api/v1/orgs/{org}/members/{issuer}/role"),
        Some(&owner),
        json!({"role":"admin"}),
    )
    .await;
    assert_eq!(r.status(), StatusCode::OK);
    let r = req(
        &app,
        "POST",
        &format!("/api/v1/orgs/{org}/invites/accept"),
        Some(&recipient),
        accept_input(&i, &email),
    )
    .await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(body(r).await["member"]["role"], "admin");
}

#[sqlx::test]
async fn members_invites_roles_and_capabilities_denial_matrix_has_positive_controls(
    pool: sqlx::PgPool,
) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let pool = pools.admin;
    crate::database::tests::context::context_policies(&pool).await;
    let org = org(&pool).await;
    let foreign = org_fn(&pool).await;
    let (_, target, _, _) = account(&pool, org, Role::Member).await;
    let (_, foreign_member, _, foreign_token) = account(&pool, foreign, Role::Owner).await;
    let app = crate::app(AppState::for_test(pools.app.clone()).await);
    // A second Owner keeps the role-change positive control independent of last-Owner protection.
    account(&pool, org, Role::Owner).await;
    for role in crate::auth::ALL_ROLES {
        let (_, _, _, token) = account(&pool, org, role).await;
        let me = body(
            req(
                &app,
                "GET",
                &format!("/api/v1/orgs/{org}/me"),
                Some(&token),
                Value::Null,
            )
            .await,
        )
        .await;
        assert_eq!(
            me["organization"]["capabilities"]["can_invite"]["allowed"],
            matches!(role, Role::Owner | Role::Admin)
        );
        assert_eq!(
            me["organization"]["capabilities"]["can_manage_roles"]["allowed"],
            role == Role::Owner
        );
        let r = req(
            &app,
            "GET",
            &format!("/api/v1/orgs/{org}/members"),
            Some(&token),
            Value::Null,
        )
        .await;
        assert_eq!(r.status(), StatusCode::OK);
        assert!(
            body(r).await["members"]
                .as_array()
                .unwrap()
                .iter()
                .all(|m| m["id"] != foreign_member.to_string() && m.get("email").is_none())
        );
        for target_role in crate::auth::ALL_ROLES {
            let r = req(
                &app,
                "POST",
                &format!("/api/v1/orgs/{org}/invites"),
                Some(&token),
                json!({"email":"new@example.invalid","role":target_role}),
            )
            .await;
            assert_eq!(
                r.status(),
                if role == Role::Owner || (role == Role::Admin && target_role != Role::Owner) {
                    StatusCode::CREATED
                } else {
                    StatusCode::FORBIDDEN
                }
            );
        }
        let r = req(
            &app,
            "PATCH",
            &format!("/api/v1/orgs/{org}/members/{target}/role"),
            Some(&token),
            json!({"role":"member"}),
        )
        .await;
        assert_eq!(
            r.status(),
            if role == Role::Owner {
                StatusCode::OK
            } else {
                StatusCode::FORBIDDEN
            }
        );
        let r = req(
            &app,
            "PATCH",
            &format!("/api/v1/orgs/{org}/members/{foreign_member}/role"),
            Some(&token),
            json!({"role":"owner"}),
        )
        .await;
        assert_eq!(
            r.status(),
            if role == Role::Owner {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::FORBIDDEN
            }
        );
        let r = req(
            &app,
            "POST",
            &format!("/api/v1/orgs/{org}/channels"),
            Some(&token),
            json!({"name":format!("{role:?}"),"visibility":"public"}),
        )
        .await;
        assert_eq!(
            r.status(),
            if role == Role::Guest {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::CREATED
            }
        );
        if role != Role::Guest {
            assert_eq!(
                body(r).await["capabilities"]["can_add_members"]["allowed"],
                matches!(role, Role::Owner | Role::Admin)
            );
        }
        for (method, path, input) in [
            (
                "GET",
                format!("/api/v1/orgs/{foreign}/members"),
                Value::Null,
            ),
            (
                "POST",
                format!("/api/v1/orgs/{foreign}/invites"),
                json!({"email":"new@example.invalid","role":"member"}),
            ),
            (
                "PATCH",
                format!("/api/v1/orgs/{foreign}/members/{foreign_member}/role"),
                json!({"role":"guest"}),
            ),
        ] {
            let r = req(&app, method, &path, Some(&token), input).await;
            assert_eq!(r.status(), StatusCode::NOT_FOUND);
            assert_eq!(body(r).await["error"], "organization_unavailable");
        }
    }
    assert_eq!(
        req(
            &app,
            "GET",
            &format!("/api/v1/orgs/{foreign}/members"),
            Some(&foreign_token),
            Value::Null
        )
        .await
        .status(),
        StatusCode::OK
    );
    pools.app.close().await;
}
async fn org_fn(pool: &sqlx::PgPool) -> Uuid {
    org(pool).await
}

#[sqlx::test]
async fn invite_existing_account_requires_signed_in_matching_account_and_is_single_use(
    pool: sqlx::PgPool,
) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let pool = pools.admin;
    crate::database::tests::context::context_policies(&pool).await;
    let org = org(&pool).await;
    let other = org_fn(&pool).await;
    let (_, _, _, owner) = account(&pool, org, Role::Owner).await;
    let (_, _, email, token) = account(&pool, other, Role::Member).await;
    let app = crate::app(AppState::for_test(pools.app.clone()).await);
    let i = invite(&app, org, &owner, &email, Role::Admin).await;
    let hash: Vec<u8> =
        sqlx::query_scalar("SELECT token_hash FROM invites WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(i["id"].as_str().unwrap().parse::<Uuid>().unwrap())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(bool::from(hash.ct_eq(&Sha256::digest(
        i["token"].as_str().unwrap().as_bytes()
    ))));
    let input = accept_input(&i, &email);
    let path = format!("/api/v1/orgs/{org}/invites/accept");
    let r = req(&app, "POST", &path, None, input.clone()).await;
    assert_eq!(r.status(), StatusCode::CONFLICT);
    assert_eq!(body(r).await["error"], "invite_sign_in_required");
    let r = req(&app, "POST", &path, Some(&owner), input.clone()).await;
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    assert_eq!(body(r).await["error"], "invite_account_mismatch");
    assert_eq!(
        req(&app, "POST", &path, Some("invalid"), input.clone())
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let r = req(&app, "POST", &path, Some(&token), input.clone()).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(body(r).await["member"]["role"], "admin");
    assert_eq!(
        req(&app, "POST", &path, Some(&token), input).await.status(),
        StatusCode::NOT_FOUND
    );
    pools.app.close().await;
}

#[sqlx::test]
async fn invite_unknown_expired_used_foreign_and_wrong_email_deny_without_consuming(
    pool: sqlx::PgPool,
) {
    let org = org(&pool).await;
    let other = org_fn(&pool).await;
    let (_, _, _, owner) = account(&pool, org, Role::Owner).await;
    let (_, _, email, token) = account(&pool, other, Role::Member).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    let i = invite(&app, org, &owner, &email, Role::Guest).await;
    let path = format!("/api/v1/orgs/{org}/invites/accept");
    let wrong = accept_input(&i, "wrong@example.invalid");
    assert_eq!(
        req(&app, "POST", &path, Some(&token), wrong).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        req(
            &app,
            "POST",
            &format!("/api/v1/orgs/{other}/invites/accept"),
            Some(&token),
            accept_input(&i, &email)
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let mut wrong = accept_input(&i, &email);
    wrong["token"] = json!("0".repeat(64));
    assert_eq!(
        req(&app, "POST", &path, Some(&token), wrong).await.status(),
        StatusCode::NOT_FOUND
    );
    sqlx::query("UPDATE invites SET expires_at=now()-interval '1 second' WHERE organization_id=$1")
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        req(&app, "POST", &path, Some(&token), accept_input(&i, &email))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let i = invite(&app, org, &owner, &email, Role::Guest).await;
    assert_eq!(
        req(&app, "POST", &path, Some(&token), accept_input(&i, &email))
            .await
            .status(),
        StatusCode::OK
    );
    let consumed: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM invites WHERE organization_id=$1 AND accepted_at IS NOT NULL",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(consumed, 1);
}

#[sqlx::test]
async fn new_account_acceptance_is_atomic_and_concurrent_consumption_has_one_winner(
    pool: sqlx::PgPool,
) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let pool = pools.admin;
    crate::database::tests::context::context_policies(&pool).await;
    let org = org(&pool).await;
    let (_, _, _, owner) = account(&pool, org, Role::Owner).await;
    let app = crate::app(AppState::for_test(pools.app.clone()).await);
    let email = "new@example.invalid";
    let i = invite(&app, org, &owner, email, Role::Member).await;
    let path = format!("/api/v1/orgs/{org}/invites/accept");
    let mut input = accept_input(&i, email);
    input["password"] = json!("short");
    assert_eq!(
        req(&app, "POST", &path, None, input.clone()).await.status(),
        StatusCode::BAD_REQUEST
    );
    input["password"] = json!("test password with enough characters");
    let (a, b) = tokio::join!(
        req(&app, "POST", &path, None, input.clone()),
        req(&app, "POST", &path, None, input)
    );
    assert_eq!(
        u8::from(a.status() == StatusCode::OK) + u8::from(b.status() == StatusCode::OK),
        1
    );
    let accounts: i64 = sqlx::query_scalar("SELECT count(*) FROM accounts WHERE email=$1")
        .bind(email)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(accounts, 1);
    let stored: String = sqlx::query_scalar("SELECT password_hash FROM accounts WHERE email=$1")
        .bind(email)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(stored.starts_with("$argon2"));
    let memberships:i64=sqlx::query_scalar("SELECT count(*) FROM users u JOIN accounts a ON a.id=u.account_id WHERE organization_id=$1 AND email=$2").bind(org).bind(email).fetch_one(&pool).await.unwrap();
    assert_eq!(memberships, 1);
    pools.app.close().await;
}

#[sqlx::test]
async fn reinvite_reuses_member_row_without_restoring_channel_grants_or_changing_active_roles(
    pool: sqlx::PgPool,
) {
    let org = org(&pool).await;
    let (_, _, _, owner) = account(&pool, org, Role::Owner).await;
    let (id, member, email, token) = account(&pool, org, Role::Member).await;
    let channel = Uuid::new_v4();
    sqlx::query("INSERT INTO channels (organization_id,id,name,visibility) VALUES ($1,$2,'Private','private')").bind(org).bind(channel).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
    )
    .bind(org)
    .bind(channel)
    .bind(member)
    .execute(&pool)
    .await
    .unwrap();
    let app = crate::app(AppState::for_test(pool.clone()).await);
    let path = format!("/api/v1/orgs/{org}/invites/accept");
    let i = invite(&app, org, &owner, &email, Role::Guest).await;
    assert_eq!(
        req(&app, "POST", &path, Some(&token), accept_input(&i, &email))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let role: Role =
        sqlx::query_scalar("SELECT role FROM users WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(member)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(role, Role::Member);
    deactivate_member(&AppState::for_test(pool.clone()).await, org, id)
        .await
        .unwrap();
    let r = req(&app, "POST", &path, Some(&token), accept_input(&i, &email)).await;
    assert_eq!(r.status(), StatusCode::OK);
    let r = body(r).await;
    assert_eq!(r["member"]["id"], member.to_string());
    assert_eq!(r["member"]["role"], "guest");
    let response = req(
        &app,
        "GET",
        &format!("/api/v1/orgs/{org}/channels/{channel}/messages"),
        Some(&token),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let revision: i64 = sqlx::query_scalar(
        "SELECT membership_revision FROM users WHERE organization_id=$1 AND id=$2",
    )
    .bind(org)
    .bind(member)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(revision, 1);
}

#[sqlx::test]
async fn last_owner_demotion_and_deactivation_are_rejected_with_concurrent_positive_control(
    pool: sqlx::PgPool,
) {
    let org = org(&pool).await;
    let (id, member, _, owner) = account(&pool, org, Role::Owner).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    let path = format!("/api/v1/orgs/{org}/members/{member}/role");
    let r = req(&app, "PATCH", &path, Some(&owner), json!({"role":"admin"})).await;
    assert_eq!(r.status(), StatusCode::CONFLICT);
    assert_eq!(body(r).await["error"], "last_owner");
    assert!(
        deactivate_member(&AppState::for_test(pool.clone()).await, org, id)
            .await
            .is_err()
    );
    let (_, member2, _, owner2) = account(&pool, org, Role::Owner).await;
    let path2 = format!("/api/v1/orgs/{org}/members/{member2}/role");
    let (a, b) = tokio::join!(
        req(&app, "PATCH", &path, Some(&owner), json!({"role":"member"})),
        req(
            &app,
            "PATCH",
            &path2,
            Some(&owner2),
            json!({"role":"member"})
        )
    );
    assert_eq!(
        u8::from(a.status() == StatusCode::OK) + u8::from(b.status() == StatusCode::OK),
        1
    );
    let owners:i64=sqlx::query_scalar("SELECT count(*) FROM users WHERE organization_id=$1 AND role='owner' AND deactivated_at IS NULL").bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(owners, 1);
}

#[sqlx::test]
async fn every_role_rest_channel_denials_and_grants_have_positive_controls(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let foreign = org_fn(&pool).await;
    let (_, _, _, owner) = account(&pool, org, Role::Owner).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    let mut channels = Vec::new();
    for visibility in ["public", "private"] {
        let r = req(
            &app,
            "POST",
            &format!("/api/v1/orgs/{org}/channels"),
            Some(&owner),
            json!({"name":visibility,"visibility":visibility}),
        )
        .await;
        let c = body(r).await;
        let id = c["id"].as_str().unwrap().parse::<Uuid>().unwrap();
        let r = req(
            &app,
            "POST",
            &format!("/api/v1/orgs/{org}/channels/{id}/messages"),
            Some(&owner),
            json!({"client_message_id":Uuid::new_v4(),"body":"seed","topic_name":"Topic"}),
        )
        .await;
        assert_eq!(r.status(), StatusCode::CREATED);
        let message = body(r).await;
        channels.push((
            id,
            visibility,
            message["topic_id"].as_str().unwrap().to_owned(),
        ));
    }
    for role in crate::auth::ALL_ROLES {
        let (_, member, _, token) = account(&pool, org, role).await;
        for (channel, visibility, topic) in &channels {
            for grant in [false, true] {
                if grant {
                    sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)").bind(org).bind(channel).bind(member).execute(&pool).await.unwrap();
                }
                let allowed = grant || (*visibility == "public" && role != Role::Guest);
                for suffix in [
                    "messages".to_string(),
                    "timeline".into(),
                    "topics".into(),
                    format!("topics/{topic}"),
                    format!("topics/{topic}/messages"),
                ] {
                    let r = req(
                        &app,
                        "GET",
                        &format!("/api/v1/orgs/{org}/channels/{channel}/{suffix}"),
                        Some(&token),
                        Value::Null,
                    )
                    .await;
                    assert_eq!(
                        r.status(),
                        if allowed {
                            StatusCode::OK
                        } else {
                            StatusCode::NOT_FOUND
                        }
                    );
                    if !allowed {
                        assert_eq!(body(r).await["error"], "channel not found");
                    }
                }
                let r = req(
                    &app,
                    "POST",
                    &format!("/api/v1/orgs/{org}/channels/{channel}/messages"),
                    Some(&token),
                    json!({"client_message_id":Uuid::new_v4(),"body":"role control"}),
                )
                .await;
                assert_eq!(
                    r.status(),
                    if allowed {
                        StatusCode::CREATED
                    } else {
                        StatusCode::NOT_FOUND
                    }
                );
            }
            let r = req(
                &app,
                "GET",
                &format!("/api/v1/orgs/{foreign}/channels/{channel}/messages"),
                Some(&token),
                Value::Null,
            )
            .await;
            assert_eq!(r.status(), StatusCode::NOT_FOUND);
            assert_eq!(body(r).await["error"], "organization_unavailable");
        }
    }
}

#[sqlx::test]
async fn queued_invite_expiry_and_new_account_uniqueness_race_never_attach_by_email(
    pool: sqlx::PgPool,
) {
    let org = org(&pool).await;
    let other = org_fn(&pool).await;
    let (_, _, _, owner) = account(&pool, org, Role::Owner).await;
    let (_, _, _, other_owner) = account(&pool, other, Role::Owner).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    let email = "race@example.invalid";
    let a = invite(&app, org, &owner, email, Role::Member).await;
    let b = invite(&app, other, &other_owner, email, Role::Guest).await;
    let mut input_a = accept_input(&a, email);
    input_a["password"] = json!("test password with enough characters");
    let mut input_b = accept_input(&b, email);
    input_b["password"] = json!("another password with enough characters");
    let path_a = format!("/api/v1/orgs/{org}/invites/accept");
    let path_b = format!("/api/v1/orgs/{other}/invites/accept");
    let (a, b) = tokio::join!(
        req(&app, "POST", &path_a, None, input_a),
        req(&app, "POST", &path_b, None, input_b)
    );
    let mut statuses = [a.status().as_u16(), b.status().as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409]);
    let memberships: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM users u JOIN accounts a ON a.id=u.account_id WHERE a.email=$1",
    )
    .bind(email)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(memberships, 1);
    let (_, _, email, token) = account(&pool, other, Role::Member).await;
    let i = invite(&app, org, &owner, &email, Role::Member).await;
    let mut tx = pool.begin().await.unwrap();
    members::lock_organization(&mut tx, org).await.unwrap();
    sqlx::query("UPDATE invites SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE organization_id=$1 AND id=$2").bind(org).bind(i["id"].as_str().unwrap().parse::<Uuid>().unwrap()).execute(&pool).await.unwrap();
    let task = tokio::spawn({
        let app = app.clone();
        async move {
            req(
                &app,
                "POST",
                &format!("/api/v1/orgs/{org}/invites/accept"),
                Some(&token),
                accept_input(&i, &email),
            )
            .await
        }
    });
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    tx.commit().await.unwrap();
    assert_eq!(task.await.unwrap().status(), StatusCode::NOT_FOUND);
}

fn captured_auth(org: Uuid, id: Uuid, account: Uuid, token: &str, role: Role) -> Auth {
    Auth {
        identity: Identity {
            organization: Organization {
                organization_id: org,
                name: "Test".into(),
                capabilities: OrganizationCapabilities::for_member(org, role),
            },
            member: Member {
                id,
                name: "Test".into(),
                role,
            },
        },
        account_id: account,
        membership_revision: 0,
        token_hash: Sha256::digest(token.as_bytes()).to_vec(),
    }
}

#[sqlx::test]
async fn writes_reauthorize_role_deactivation_and_revision_after_auth_with_positive_controls(
    pool: sqlx::PgPool,
) {
    let org = org(&pool).await;
    account(&pool, org, Role::Owner).await;
    let (_, target, _, _) = account(&pool, org, Role::Member).await;
    let state = AppState::for_test(pool.clone()).await;
    for loss in ["role", "deactivate", "revision"] {
        let (id, member, _, token) = account(&pool, org, Role::Owner).await;
        // Positive control uses the same captured actor and server handler.
        let r = create_invite(
            State(state.clone()),
            captured_auth(org, member, id, &token, Role::Owner),
            ApiJson(CreateInviteRequest {
                email: "new@example.invalid".into(),
                role: Role::Member,
            }),
        )
        .await;
        assert_eq!(r.unwrap().status(), StatusCode::CREATED);
        let invite_auth = captured_auth(org, member, id, &token, Role::Owner);
        let role_auth = captured_auth(org, member, id, &token, Role::Owner);
        let list_auth = captured_auth(org, member, id, &token, Role::Owner);
        if loss == "role" {
            sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(member)
                .execute(&pool)
                .await
                .unwrap();
        } else {
            deactivate_member(&state, org, id).await.unwrap();
            if loss == "revision" {
                sqlx::query(
                    "UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2",
                )
                .bind(org)
                .bind(member)
                .execute(&pool)
                .await
                .unwrap();
            }
        }
        let listed = members::list_members(State(state.clone()), list_auth)
            .await
            .unwrap_or_else(|error| error.into_response());
        assert_eq!(
            listed.status(),
            if loss == "role" {
                StatusCode::OK
            } else {
                StatusCode::NOT_FOUND
            }
        );
        let status = if loss == "role" {
            StatusCode::FORBIDDEN
        } else {
            StatusCode::NOT_FOUND
        };
        let error = create_invite(
            State(state.clone()),
            invite_auth,
            ApiJson(CreateInviteRequest {
                email: "denied@example.invalid".into(),
                role: Role::Member,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.into_response().status(), status);
        let error = members::change_role::<ActorRecheckGuard>(
            State(state.clone()),
            role_auth,
            Ok(Path((org, target))),
            ApiJson(members::ChangeRoleRequest { role: Role::Owner }),
        )
        .await
        .unwrap_err();
        assert_eq!(error.into_response().status(), status);
    }
    let denied: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM invites WHERE organization_id=$1 AND email='denied@example.invalid'",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(denied, 0);
}

// This direct-handler test isolates auth reauthorization. HTTP tests exercise
// the production Channel guard supplied by the composition root.
struct ActorRecheckGuard;
impl members::RoleChangeGuard for ActorRecheckGuard {
    async fn check_deactivation(
        &self,
        _: &mut sqlx::PgConnection,
        _: Uuid,
        _: Uuid,
    ) -> Result<(), ApiError> {
        Ok(())
    }

    async fn lock(_: &mut sqlx::PgConnection, _: Uuid, _: Uuid) -> Result<Self, ApiError> {
        Ok(Self)
    }
    async fn check(
        &self,
        _: &mut sqlx::PgConnection,
        _: Uuid,
        _: Uuid,
        _: Role,
    ) -> Result<(), ApiError> {
        panic!("unauthorized actor reached Role-change protection")
    }
}

#[sqlx::test]
async fn last_owner_guard_rejects_stale_repeatable_read_snapshots_and_direct_sql_transitions(
    pool: sqlx::PgPool,
) {
    let org = org(&pool).await;
    let (_, a, _, _) = account(&pool, org, Role::Owner).await;
    let (_, b, _, _) = account(&pool, org, Role::Owner).await;
    let mut stale = pool
        .begin_with("BEGIN ISOLATION LEVEL REPEATABLE READ")
        .await
        .unwrap();
    let owners: i64 =
        sqlx::query_scalar("SELECT count(*) FROM users WHERE organization_id=$1 AND role='owner'")
            .bind(org)
            .fetch_one(&mut *stale)
            .await
            .unwrap();
    assert_eq!(owners, 2);
    sqlx::query("UPDATE users SET role='member' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(a)
        .execute(&pool)
        .await
        .unwrap();
    let error = sqlx::query("UPDATE users SET role='admin' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(b)
        .execute(&mut *stale)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("40001")
    );
    stale.rollback().await.unwrap();
    let error =
        sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(b)
            .execute(&pool)
            .await
            .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().constraint(),
        Some("users_last_owner")
    );
    sqlx::query("UPDATE users SET role='owner' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(a)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(b)
        .execute(&pool)
        .await
        .unwrap();
    let owners:i64=sqlx::query_scalar("SELECT count(*) FROM users WHERE organization_id=$1 AND role='owner' AND deactivated_at IS NULL").bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(owners, 1);
}

#[sqlx::test]
async fn invite_acceptance_uses_configured_web_cookie_and_never_downgrades_invalid_credentials(
    pool: sqlx::PgPool,
) {
    let org = org(&pool).await;
    let other = org_fn(&pool).await;
    let (_, _, _, owner) = account(&pool, org, Role::Owner).await;
    for secure in [true, false] {
        let app = crate::app(AppState {
            cookie_secure: secure,
            ..AppState::for_test(pool.clone()).await
        });
        for name in [COOKIE, SECURE_COOKIE, "analytics"] {
            let (_, _, email, token) = account(&pool, other, Role::Member).await;
            let invite = invite(&app, org, &owner, &email, Role::Member).await;
            let r = app
                .clone()
                .oneshot(
                    Request::post(format!("/api/v1/orgs/{org}/invites/accept"))
                        .header(header::CONTENT_TYPE, "application/json")
                        .header(header::COOKIE, format!("{name}={token}"))
                        .body(Body::from(accept_input(&invite, &email).to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            let expected = if name == cookie_name(secure) {
                StatusCode::OK
            } else if name == "analytics" {
                StatusCode::CONFLICT
            } else {
                StatusCode::UNAUTHORIZED
            };
            assert_eq!(r.status(), expected);
        }
    }
}

#[sqlx::test]
async fn role_change_unknown_foreign_and_inactive_targets_deny_with_active_positive_control(
    pool: sqlx::PgPool,
) {
    let org = org(&pool).await;
    let other = org_fn(&pool).await;
    let (_, _, _, owner) = account(&pool, org, Role::Owner).await;
    let (account_id, inactive, _, _) = account(&pool, org, Role::Member).await;
    let (_, foreign, _, _) = account(&pool, other, Role::Member).await;
    let (_, active, _, _) = account(&pool, org, Role::Member).await;
    let state = AppState::for_test(pool.clone()).await;
    let app = crate::app(state.clone());
    deactivate_member(&state, org, account_id).await.unwrap();
    for id in [Uuid::new_v4(), foreign, inactive] {
        let r = req(
            &app,
            "PATCH",
            &format!("/api/v1/orgs/{org}/members/{id}/role"),
            Some(&owner),
            json!({"role":"guest"}),
        )
        .await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
        assert_eq!(body(r).await, json!({"error":"member_not_found"}));
    }
    let r = req(
        &app,
        "PATCH",
        &format!("/api/v1/orgs/{org}/members/{active}/role"),
        Some(&owner),
        json!({"role":"guest"}),
    )
    .await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(body(r).await["role"], "guest");
}
