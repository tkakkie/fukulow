use super::*;
use auth::members::list_members;

async fn directory(app: &Router, token: &str) -> Value {
    let response = request(app, "GET", "/api/v1/members", token, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    body(response).await
}
fn expected(ids: &[Uuid], role: &str) -> Value {
    let mut ids = ids.to_vec();
    ids.sort();
    json!({"members":ids.into_iter().map(|id| json!({"id":id,"name":"Member","role":role})).collect::<Vec<_>>()})
}
async fn grant(pool: &PgPool, org: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id,membership_revision) SELECT organization_id,$2,id,membership_revision FROM users WHERE organization_id=$1 AND id=$3")
        .bind(org).bind(channel).bind(member).execute(pool).await.unwrap();
}
async fn revoke(pool: &PgPool, org: Uuid, channel: Uuid, member: Uuid) {
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
async fn deactivate(pool: &PgPool, org: Uuid, member: Uuid, reactivate: bool) {
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(member)
        .execute(pool)
        .await
        .unwrap();
    if reactivate {
        sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(member)
            .execute(pool)
            .await
            .unwrap();
    }
}
async fn channel_id(app: &Router, owner: &str, visibility: &str) -> Uuid {
    create(app, owner, &Uuid::new_v4().to_string(), visibility).await["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}

#[fukulow_test::test]
async fn guest_directory_denies_unrelated_ungranted_public_private_and_stale_grants(pool: PgPool) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let org = organization(&pools.admin).await;
    let owner_id = Uuid::new_v4();
    let owner = member(&pools.admin, org, owner_id, "owner").await;
    let guest = Uuid::new_v4();
    let token = member(&pools.admin, org, guest, "guest").await;
    let app = router(&pools.app).await;
    // Each denial has a positive control on the same public/private Channel.
    for visibility in ["public", "private"] {
        let channel = channel_id(&app, &owner, visibility).await;
        let peer = Uuid::new_v4();
        member(&pools.admin, org, peer, "guest").await;
        grant(&pools.admin, org, channel, peer).await;
        assert_eq!(directory(&app, &token).await, expected(&[guest], "guest"));
        grant(&pools.admin, org, channel, guest).await;
        let mut shared = expected(&[guest, peer], "guest");
        if visibility == "private" {
            shared = expected(&[guest, peer, owner_id], "guest");
            for member in shared["members"].as_array_mut().unwrap() {
                if member["id"] == owner_id.to_string() {
                    member["role"] = json!("owner");
                }
            }
        }
        assert_eq!(directory(&app, &token).await, shared);
        let response = request(
            &app,
            "GET",
            &format!("/api/v1/channels/{channel}/members"),
            &token,
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let mut grants = body(response).await;
        for member in grants["members"].as_array_mut().unwrap() {
            member.as_object_mut().unwrap().remove("manager");
        }
        assert_eq!(shared, grants);
        // Stale caller grants deny sharing even on a public Channel.
        sqlx::query("UPDATE channel_members SET membership_revision=membership_revision+1 WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
            .bind(org).bind(channel).bind(guest).execute(&pools.admin).await.unwrap();
        assert_eq!(directory(&app, &token).await, expected(&[guest], "guest"));
        revoke(&pools.admin, org, channel, guest).await;
    }
    // Public visibility alone never makes a candidate a shared grantee.
    let public = channel_id(&app, &owner, "public").await;
    let unrelated = Uuid::new_v4();
    let unrelated_token = member(&pools.admin, org, unrelated, "member").await;
    grant(&pools.admin, org, public, guest).await;
    assert!(
        list(&app, &unrelated_token).await["channels"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == public.to_string())
    );
    assert_eq!(directory(&app, &token).await, expected(&[guest], "guest"));
    grant(&pools.admin, org, public, unrelated).await;
    assert!(
        directory(&app, &token).await["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == unrelated.to_string())
    );
    pools.app.close().await;
}

#[fukulow_test::test]
async fn guest_directory_refetch_removes_revoked_inactive_and_stale_peers_and_keeps_past_authors(
    pool: PgPool,
) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let org = organization(&pools.admin).await;
    let owner = member(&pools.admin, org, Uuid::new_v4(), "owner").await;
    let guest = Uuid::new_v4();
    let token = member(&pools.admin, org, guest, "guest").await;
    let app = router(&pools.app).await;
    let channel = channel_id(&app, &owner, "public").await;
    grant(&pools.admin, org, channel, guest).await;
    for loss in ["revoke", "inactive", "stale"] {
        let peer = Uuid::new_v4();
        let peer_token = member(&pools.admin, org, peer, "member").await;
        grant(&pools.admin, org, channel, peer).await;
        let sent = request(
            &app,
            "POST",
            &format!("/api/v1/channels/{channel}/messages"),
            &peer_token,
            json!({"client_message_id":Uuid::new_v4(),"body":"past Message"}),
        )
        .await;
        assert_eq!(sent.status(), StatusCode::CREATED);
        assert!(
            directory(&app, &token).await["members"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m["id"] == peer.to_string())
        );
        if loss == "revoke" {
            revoke(&pools.admin, org, channel, peer).await;
        } else {
            deactivate(&pools.admin, org, peer, loss == "stale").await;
        }
        assert_eq!(directory(&app, &token).await, expected(&[guest], "guest"));
        let response = request(
            &app,
            "POST",
            "/api/v1/message-authors",
            &token,
            json!({"ids":[peer]}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            body(response).await,
            json!({"identities":[{"id":peer,"name":"Member","deactivated":loss=="inactive"}]})
        );
        assert_eq!(directory(&app, &token).await, expected(&[guest], "guest"));
    }
    revoke(&pools.admin, org, channel, guest).await;
    assert_eq!(directory(&app, &token).await, expected(&[guest], "guest"));
    pools.app.close().await;
}

#[fukulow_test::test]
async fn directory_full_roles_keep_exact_bytes_name_id_order_and_organization_isolation(
    pool: PgPool,
) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let org = organization(&pools.admin).await;
    let mut members = vec![];
    let mut tokens = vec![];
    for (role, name) in [
        ("owner", "Z"),
        ("admin", "A"),
        ("member", "A"),
        ("guest", "M"),
    ] {
        let id = Uuid::new_v4();
        let token = member(&pools.admin, org, id, role).await;
        sqlx::query("UPDATE users SET name=$3 WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(id)
            .bind(name)
            .execute(&pools.admin)
            .await
            .unwrap();
        members.push((name, id, role));
        tokens.push(token);
    }
    let inactive = Uuid::new_v4();
    member(&pools.admin, org, inactive, "member").await;
    deactivate(&pools.admin, org, inactive, false).await;
    let foreign = organization(&pools.admin).await;
    // Colliding Member ids ensure all joins use the Organization scope.
    member(&pools.admin, foreign, members[3].1, "guest").await;
    let app = router(&pools.app).await;
    members.sort_by_key(|(name, id, _)| (*name, *id));
    let expected = format!(
        "{{\"members\":[{}]}}",
        members
            .iter()
            .map(|(name, id, role)| format!(
                "{{\"id\":\"{id}\",\"name\":\"{name}\",\"role\":\"{role}\"}}"
            ))
            .collect::<Vec<_>>()
            .join(",")
    );
    for token in tokens.iter().take(3) {
        let response = request(&app, "GET", "/api/v1/members", token, Value::Null).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            to_bytes(response.into_body(), 65536)
                .await
                .unwrap()
                .as_ref(),
            expected.as_bytes()
        );
    }
    for token in &tokens {
        let response = request(
            &app,
            "GET",
            &format!("/api/v1/orgs/{foreign}/members"),
            token,
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body(response).await,
            json!({"error":"organization_unavailable"})
        );
    }
    assert_eq!(
        directory(&app, &tokens[3]).await["members"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    pools.app.close().await;
}

#[fukulow_test::test]
async fn directory_reads_fresh_role_after_auth_and_keeps_inactive_stale_caller_denials(
    pool: PgPool,
) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let org = organization(&pools.admin).await;
    member(&pools.admin, org, Uuid::new_v4(), "owner").await;
    let id = Uuid::new_v4();
    let token = member(&pools.admin, org, id, "member").await;
    let state = AppState::for_test(pools.app.clone()).await;
    let app = crate::app(state.clone());
    for role in ["guest", "member"] {
        let captured = extract_auth(state.clone(), &token).await;
        sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(id)
            .bind(role)
            .execute(&pools.admin)
            .await
            .unwrap();
        let response =
            list_members::<members::MemberListVisibility>(State(state.clone()), captured)
                .await
                .unwrap();
        let listed = body(response).await;
        if role == "guest" {
            assert_eq!(listed, expected(&[id], "guest"));
        } else {
            assert_eq!(listed["members"].as_array().unwrap().len(), 2);
        }
        assert_eq!(directory(&app, &token).await, listed);
    }
    for reactivate in [false, true] {
        let captured = extract_auth(state.clone(), &token).await;
        deactivate(&pools.admin, org, id, reactivate).await;
        let response =
            list_members::<members::MemberListVisibility>(State(state.clone()), captured)
                .await
                .unwrap_err()
                .into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body(response).await,
            json!({"error":"organization_unavailable"})
        );
        if !reactivate {
            sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(id)
                .execute(&pools.admin)
                .await
                .unwrap();
        }
    }
    pools.app.close().await;
}

struct PausedVisibility;
impl auth::members::MemberListVisibility for PausedVisibility {
    fn shared_channel_sql() -> String {
        format!(
            "SELECT 1 FROM ({}) sharing WHERE (SELECT true FROM pg_advisory_xact_lock(315,315))",
            <members::MemberListVisibility as auth::members::MemberListVisibility>::shared_channel_sql()
        )
    }
}

#[fukulow_test::test]
async fn guest_directory_role_grants_and_results_share_one_nonlocking_snapshot(pool: PgPool) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let org = organization(&pools.admin).await;
    let owner = member(&pools.admin, org, Uuid::new_v4(), "owner").await;
    let guest = Uuid::new_v4();
    let token = member(&pools.admin, org, guest, "guest").await;
    let peer = Uuid::new_v4();
    member(&pools.admin, org, peer, "guest").await;
    let state = AppState::for_test(pools.app.clone()).await;
    let app = crate::app(state.clone());
    let channel = channel_id(&app, &owner, "public").await;
    grant(&pools.admin, org, channel, guest).await;
    grant(&pools.admin, org, channel, peer).await;
    let captured = extract_auth(state.clone(), &token).await;
    let mut blocker = pools.admin.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(315,315)")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let reader = tokio::spawn(async move {
        list_members::<PausedVisibility>(State(state), captured)
            .await
            .unwrap()
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%FROM pg_advisory_xact_lock(315,315)%')")
                .fetch_one(&pools.admin).await.unwrap();
            if waiting { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    // These writes must commit while the reader is paused: it retains no Member/grant locks.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        revoke(&pools.admin, org, channel, guest).await;
        deactivate(&pools.admin, org, peer, false).await;
        sqlx::query("UPDATE users SET role='member' WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(guest)
            .execute(&pools.admin)
            .await
            .unwrap();
        member(&pools.admin, org, Uuid::new_v4(), "member").await;
    })
    .await
    .unwrap();
    blocker.commit().await.unwrap();
    assert_eq!(
        body(reader.await.unwrap()).await,
        expected(&[guest, peer], "guest")
    );
    let fresh = directory(&app, &token).await;
    assert_eq!(fresh["members"].as_array().unwrap().len(), 3);
    assert!(
        !fresh["members"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["id"] == peer.to_string())
    );
    pools.app.close().await;
}
