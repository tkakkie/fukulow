use super::*;
use std::collections::HashSet;

async fn seed_role(
    pool: &sqlx::PgPool,
    org: Uuid,
    issuer: Uuid,
    role: Role,
    count: i32,
) -> Vec<Uuid> {
    sqlx::query_scalar(
        "INSERT INTO invites (organization_id,id,created_by,email,role,token_hash) \
         SELECT $1,gen_random_uuid(),$2,'seed-'||n||'@example.invalid',$3, \
         sha256(convert_to(gen_random_uuid()::text,'UTF8')) \
         FROM generate_series(1,$4) n RETURNING id",
    )
    .bind(org)
    .bind(issuer)
    .bind(role)
    .bind(count)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn create(app: &Router, org: Uuid, token: &str, role: Role) -> Response {
    req(
        app,
        "POST",
        &path(org),
        Some(token),
        json!({"email":"quota@example.invalid","role":role}),
    )
    .await
}

async fn full(pool: &sqlx::PgPool, app: &Router, org: Uuid, token: &str, role: Role) {
    let before = snapshot(pool).await;
    denied(
        pool,
        create(app, org, token, role).await,
        &before,
        StatusCode::CONFLICT,
        "invite_limit_reached",
    )
    .await;
}

async fn revoke(app: &Router, org: Uuid, token: &str, id: Uuid) {
    let response = req(
        app,
        "DELETE",
        &format!("{}/{id}", path(org)),
        Some(token),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

async fn accept(app: &Router, org: Uuid, token: &str, invite: &Value, email: &str, role: Role) {
    let response = req(
        app,
        "POST",
        &format!("{}/accept", path(org)),
        Some(token),
        accept_input(invite, email),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await["member"]["role"], json!(role));
}

#[fukulow_test::test]
async fn invite_quota_separates_roles_and_organizations(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let other = org_fn(&pool).await;
    let (_, owner_id, _, owner) = account(&pool, org, Role::Owner).await;
    let (_, admin_id, _, admin) = account(&pool, org, Role::Admin).await;
    let (_, other_issuer, _, other_owner) = account(&pool, other, Role::Owner).await;
    let (_, _, _, other_admin) = account(&pool, other, Role::Admin).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    seed_role(&pool, org, owner_id, Role::Member, 97).await;
    seed_role(&pool, org, owner_id, Role::Guest, 1).await;
    seed_role(&pool, org, admin_id, Role::Admin, 1).await;

    let last = invite(&app, org, &admin, "last@example.invalid", Role::Guest).await;
    full(&pool, &app, org, &admin, Role::Admin).await;
    full(&pool, &app, org, &owner, Role::Member).await;
    revoke(&app, org, &admin, id(&last)).await;

    invite(
        &app,
        org,
        &owner,
        "first-owner@example.invalid",
        Role::Owner,
    )
    .await;
    seed_role(&pool, org, owner_id, Role::Owner, 8).await;
    invite(
        &app,
        org,
        &owner,
        "tenth-owner@example.invalid",
        Role::Owner,
    )
    .await;
    full(&pool, &app, org, &owner, Role::Owner).await;
    // With 99 non-Owner and 10 Owner-Role Outstanding Invites, Admin can fill
    // exactly the remaining non-Owner slot and sees only the new Invite.
    let last = invite(&app, org, &admin, "last@example.invalid", Role::Member).await;
    let public_fields = HashSet::from(["id", "organization_id", "token", "expires_at"]);
    assert_eq!(
        last.as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<HashSet<_>>(),
        public_fields
    );
    full(&pool, &app, org, &admin, Role::Guest).await;
    full(&pool, &app, org, &owner, Role::Admin).await;

    for role in [Role::Owner, Role::Member] {
        invite(&app, other, &other_owner, "other@example.invalid", role).await;
    }
    seed_role(&pool, other, other_issuer, Role::Owner, 9).await;
    full(&pool, &app, other, &other_owner, Role::Owner).await;
    let created = invite(
        &app,
        other,
        &other_admin,
        "other-admin@example.invalid",
        Role::Guest,
    )
    .await;
    assert_eq!(
        created
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<HashSet<_>>(),
        public_fields
    );
    revoke(&app, org, &admin, id(&last)).await;
    invite(&app, org, &owner, "refill@example.invalid", Role::Admin).await;
    full(&pool, &app, org, &owner, Role::Owner).await;
}

#[fukulow_test::test]
async fn invite_quota_reuses_capacity_after_acceptance_revocation_and_expiry(pool: sqlx::PgPool) {
    let other = org(&pool).await;
    let (_, _, email, recipient) = account(&pool, other, Role::Owner).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    for (role, cap) in [(Role::Member, 100), (Role::Owner, 10)] {
        let org = org(&pool).await;
        let (_, issuer, _, owner) = account(&pool, org, Role::Owner).await;
        let accepted = invite(&app, org, &owner, &email, role).await;
        let revoked = invite(&app, org, &owner, "revoke@example.invalid", role).await;
        let expiring = invite(&app, org, &owner, "expire@example.invalid", role).await;
        seed_role(&pool, org, issuer, role, cap - 3).await;

        full(&pool, &app, org, &owner, role).await;
        accept(&app, org, &recipient, &accepted, &email, role).await;
        invite(&app, org, &owner, "after-accept@example.invalid", role).await;

        full(&pool, &app, org, &owner, role).await;
        revoke(&app, org, &owner, id(&revoked)).await;
        invite(&app, org, &owner, "after-revoke@example.invalid", role).await;

        full(&pool, &app, org, &owner, role).await;
        let expires_at: String = sqlx::query_scalar(
            "UPDATE invites SET expires_at=clock_timestamp()+interval '50 ms' \
             WHERE organization_id=$1 AND id=$2 RETURNING expires_at::text",
        )
        .bind(org)
        .bind(id(&expiring))
        .fetch_one(&pool)
        .await
        .unwrap();
        sqlx::query("SELECT pg_sleep_until($1::text::timestamptz)")
            .bind(expires_at)
            .execute(&pool)
            .await
            .unwrap();
        invite(&app, org, &owner, "after-expiry@example.invalid", role).await;
        full(&pool, &app, org, &owner, role).await;
    }
}

async fn organization_with_full_pools(pool: &sqlx::PgPool) -> Uuid {
    let org = org(pool).await;
    let (_, issuer, _, _) = account(pool, org, Role::Owner).await;
    seed_role(pool, org, issuer, Role::Member, 100).await;
    seed_role(pool, org, issuer, Role::Owner, 10).await;
    org
}

async fn assert_role_denial(pool: sqlx::PgPool, actor: Role, target: Role) {
    let org = organization_with_full_pools(&pool).await;
    let (_, _, _, token) = account(&pool, org, actor).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    let before = snapshot(&pool).await;
    denied(
        &pool,
        create(&app, org, &token, target).await,
        &before,
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;
}

#[fukulow_test::test]
async fn full_invite_pool_still_denies_member(pool: sqlx::PgPool) {
    assert_role_denial(pool, Role::Member, Role::Member).await;
}

#[fukulow_test::test]
async fn full_invite_pool_still_denies_guest(pool: sqlx::PgPool) {
    assert_role_denial(pool, Role::Guest, Role::Member).await;
}

#[fukulow_test::test]
async fn full_owner_invite_pool_still_denies_admin(pool: sqlx::PgPool) {
    assert_role_denial(pool, Role::Admin, Role::Owner).await;
}

async fn assert_membership_denial(pool: sqlx::PgPool, reactivate: bool) {
    let org = organization_with_full_pools(&pool).await;
    let (account_id, member_id, _, token) = account(&pool, org, Role::Owner).await;
    let state = AppState::for_test(pool.clone()).await;
    let auth = captured_auth(org, member_id, account_id, &token, Role::Owner);
    let mut blocker = pool.begin().await.unwrap();
    members::lock_organization(&mut blocker, org).await.unwrap();
    let pending = tokio::spawn(async move {
        create_invite(
            State(state),
            auth,
            ApiJson(CreateInviteRequest {
                email: "quota@example.invalid".into(),
                role: Role::Owner,
            }),
        )
        .await
        .unwrap_err()
        .into_response()
    });
    waiting(
        &pool,
        "SELECT organization_id FROM organizations%FOR NO KEY UPDATE",
    )
    .await;
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(member_id)
        .execute(&mut *blocker)
        .await
        .unwrap();
    if reactivate {
        sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(member_id)
            .execute(&mut *blocker)
            .await
            .unwrap();
    }
    blocker.commit().await.unwrap();
    let before = snapshot(&pool).await;
    let response = tokio::time::timeout(Duration::from_secs(10), pending)
        .await
        .unwrap()
        .unwrap();
    denied(
        &pool,
        response,
        &before,
        StatusCode::NOT_FOUND,
        "organization_unavailable",
    )
    .await;
}

#[fukulow_test::test]
async fn full_invite_pool_still_denies_inactive_actor(pool: sqlx::PgPool) {
    assert_membership_denial(pool, false).await;
}

#[fukulow_test::test]
async fn full_invite_pool_still_denies_stale_actor(pool: sqlx::PgPool) {
    assert_membership_denial(pool, true).await;
}

#[fukulow_test::test]
async fn concurrent_creators_share_the_last_invite_slot_in_each_pool(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let (_, issuer, _, owner) = account(&pool, org, Role::Owner).await;
    let (_, _, _, admin) = account(&pool, org, Role::Admin).await;
    let (_, _, _, other_owner) = account(&pool, org, Role::Owner).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    for (role, cap, second_issuer) in [(Role::Member, 100, admin), (Role::Owner, 10, other_owner)] {
        seed_role(&pool, org, issuer, role, cap - 1).await;
        let mut blocker = pool.begin().await.unwrap();
        members::lock_organization(&mut blocker, org).await.unwrap();
        let pending = [&owner, &second_issuer].map(|token| {
            let app = app.clone();
            let token = token.clone();
            tokio::spawn(async move { create(&app, org, &token, role).await })
        });
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let waiting: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() \
                     AND wait_event_type='Lock' \
                     AND query LIKE 'SELECT organization_id FROM organizations%FOR NO KEY UPDATE'",
                )
                .fetch_one(&pool)
                .await
                .unwrap();
                if waiting == 2 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        blocker.commit().await.unwrap();
        let mut statuses = Vec::new();
        for task in pending {
            let response = tokio::time::timeout(Duration::from_secs(10), task)
                .await
                .unwrap()
                .unwrap();
            statuses.push(response.status());
            if response.status() == StatusCode::CONFLICT {
                assert_eq!(
                    body(response).await,
                    json!({"error":"invite_limit_reached"})
                );
            }
        }
        assert!(statuses.contains(&StatusCode::CREATED));
        assert!(statuses.contains(&StatusCode::CONFLICT));
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM invites WHERE organization_id=$1 AND role=$2")
                .bind(org)
                .bind(role)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, i64::from(cap));
    }
}

#[fukulow_test::test]
async fn above_cap_invites_stay_manageable_until_each_pool_drains(pool: sqlx::PgPool) {
    let other = org(&pool).await;
    let (_, _, email, recipient) = account(&pool, other, Role::Owner).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    for (role, cap) in [(Role::Member, 100), (Role::Owner, 10)] {
        let org = org(&pool).await;
        let (_, issuer, _, owner) = account(&pool, org, Role::Owner).await;
        let accepted = invite(&app, org, &owner, &email, role).await;
        let seeded = seed_role(&pool, org, issuer, role, cap + 1).await;
        let expected: HashSet<_> = seeded.iter().copied().chain([id(&accepted)]).collect();
        let mut listed = Vec::new();
        let mut cursor = None;
        loop {
            let result = page(&app, org, &owner, cursor.as_deref()).await;
            listed.extend(result["invites"].as_array().unwrap().iter().map(id));
            cursor = result["next_cursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(listed.len(), expected.len());
        assert_eq!(listed.into_iter().collect::<HashSet<_>>(), expected);

        full(&pool, &app, org, &owner, role).await;
        accept(&app, org, &recipient, &accepted, &email, role).await;
        full(&pool, &app, org, &owner, role).await;
        revoke(&app, org, &owner, seeded[0]).await;
        full(&pool, &app, org, &owner, role).await;
        revoke(&app, org, &owner, seeded[1]).await;
        invite(&app, org, &owner, "after-drain@example.invalid", role).await;
        full(&pool, &app, org, &owner, role).await;

        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM invites WHERE organization_id=$1")
                .bind(org)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, i64::from(cap + 3));
    }
}
