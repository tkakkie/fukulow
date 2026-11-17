use super::*;

async fn denial(pool: PgPool, case: &str) {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let (_, org, sender, public, author) = fixture(&pool).await;
    let private = Uuid::new_v4();
    crate::messages::tests::channel(&pool, org, private, sender, true).await;
    let target_org = if case == "foreign_organization" {
        organization(&pool).await
    } else {
        org
    };
    let actor = Uuid::new_v4();
    let token = member(&pool, target_org, actor).await;
    let role = match case {
        "private_owner" | "dm_owner" => "owner",
        "private_admin" | "dm_admin" => "admin",
        "guest_public" | "private_guest" => "guest",
        _ => "member",
    };
    sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
        .bind(target_org)
        .bind(actor)
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    let state = AppState::for_test(pool.clone()).await;
    let delivery = state.message_delivery.clone();
    let app = crate::app(state.clone());
    let dm = case.starts_with("dm_");
    let channel = if dm {
        let peer = Uuid::new_v4();
        member(&pool, org, peer).await;
        let r = request(
            &app,
            "POST",
            "/api/v1/dms",
            &author,
            json!({"member_id":peer}),
        )
        .await;
        assert_eq!(r.status(), StatusCode::CREATED);
        body(r).await["id"].as_str().unwrap().parse().unwrap()
    } else if case == "guest_public" {
        public
    } else {
        private
    };
    let root = sent(&app, &author, channel, input(Uuid::new_v4(), "Root")).await;
    let child = sent(&app, &author, channel, reply_input(Uuid::new_v4(), &root)).await;
    let ids = [id(&root), id(&child)];
    let positive = page(&app, &author, channel, &ids).await;
    assert_eq!(positive["counts"].as_array().unwrap().len(), 2);
    for e in positive["counts"].as_array().unwrap() {
        assert_eq!(e["reply_count"], 1);
    }
    let can_grant = target_org == org && !dm;
    let captured = if can_grant {
        grant(&pool, org, channel, actor).await;
        assert_eq!(page(&app, &token, channel, &ids).await, positive);
        Some(crate::messages::tests::membership::captured_auth(&pool, &token).await)
    } else {
        None
    };
    match case {
        "deactivated" | "stale_revision" => {
            sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(actor)
                .execute(&pool)
                .await
                .unwrap();
            if case == "stale_revision" {
                sqlx::query(
                    "UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2",
                )
                .bind(org)
                .bind(actor)
                .execute(&pool)
                .await
                .unwrap();
            }
        }
        _ if can_grant => revoke(&pool, org, channel, actor).await,
        _ => {}
    }
    let mut permits = Vec::new();
    for _ in 0..4 {
        permits.push(
            delivery
                .admission(&state.pool)
                .acquire(org, channel, false)
                .await
                .unwrap(),
        );
    }
    let path = format!("/api/v1/orgs/{org}/channels/{channel}/reply-counts");
    let expected = if ["foreign_organization", "deactivated"].contains(&case) {
        "organization_unavailable"
    } else {
        "channel not found"
    };
    error(
        request(&app, "POST", &path, &token, json!({"ids":ids})).await,
        StatusCode::NOT_FOUND,
        expected,
    )
    .await;
    if let Some(auth) = captured {
        let response = reply_counts(
            State(state.clone()),
            DeferredOrganizationAuth(Some(auth)),
            Ok(Path((org, channel))),
            ApiJson(ReplyCountRequest { ids: ids.to_vec() }),
        )
        .await
        .unwrap_err()
        .into_response();
        error(
            response,
            StatusCode::NOT_FOUND,
            if case == "stale_revision" {
                "organization_unavailable"
            } else {
                expected
            },
        )
        .await;
    }
    // Unknown Channels use exactly the same inaccessible-Channel response.
    if expected == "channel not found" {
        error(
            query(&app, &token, Uuid::new_v4(), &ids).await,
            StatusCode::NOT_FOUND,
            expected,
        )
        .await;
    }
    let response = query(&app, &author, channel, &ids).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        (1..=5).contains(
            &response.headers()[header::RETRY_AFTER]
                .to_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
        )
    );
    error(
        response,
        StatusCode::SERVICE_UNAVAILABLE,
        "projection admission unavailable",
    )
    .await;
    // Invalid batches still precede the saturated watermark admission.
    assert_error(
        query(&app, &author, channel, &[id(&root); 101]).await,
        StatusCode::BAD_REQUEST,
    )
    .await;
    drop(permits);
    assert_eq!(page(&app, &author, channel, &ids).await, positive);
}

#[fukulow_test::test]
async fn reply_counts_deny_other_organization(pool: PgPool) {
    denial(pool, "foreign_organization").await;
}
#[fukulow_test::test]
async fn reply_counts_deny_private_nonmember(pool: PgPool) {
    denial(pool, "private_member").await;
}
#[fukulow_test::test]
async fn reply_counts_deny_private_owner_nonmember(pool: PgPool) {
    denial(pool, "private_owner").await;
}
#[fukulow_test::test]
async fn reply_counts_deny_private_admin_nonmember(pool: PgPool) {
    denial(pool, "private_admin").await;
}
#[fukulow_test::test]
async fn reply_counts_deny_guest_without_public_grant(pool: PgPool) {
    denial(pool, "guest_public").await;
}
#[fukulow_test::test]
async fn reply_counts_deny_revoked_grant(pool: PgPool) {
    denial(pool, "revoked").await;
}
#[fukulow_test::test]
async fn reply_counts_deny_deactivated_member(pool: PgPool) {
    denial(pool, "deactivated").await;
}
#[fukulow_test::test]
async fn reply_counts_deny_stale_membership_revision_and_grant(pool: PgPool) {
    denial(pool, "stale_revision").await;
}
#[fukulow_test::test]
async fn reply_counts_deny_dm_nonparticipant(pool: PgPool) {
    denial(pool, "dm_member").await;
}
#[fukulow_test::test]
async fn reply_counts_deny_dm_owner_nonparticipant(pool: PgPool) {
    denial(pool, "dm_owner").await;
}
#[fukulow_test::test]
async fn reply_counts_deny_dm_admin_nonparticipant(pool: PgPool) {
    denial(pool, "dm_admin").await;
}

#[fukulow_test::test]
async fn reply_counts_guest_dm_participant_requires_current_grant(pool: PgPool) {
    let (app, org, _, _, author) = fixture(&pool).await;
    let peer = Uuid::new_v4();
    let token = member(&pool, org, peer).await;
    sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(peer)
        .execute(&pool)
        .await
        .unwrap();
    let r = request(
        &app,
        "POST",
        "/api/v1/dms",
        &author,
        json!({"member_id":peer}),
    )
    .await;
    assert_eq!(r.status(), StatusCode::CREATED);
    let channel = body(r).await["id"].as_str().unwrap().parse().unwrap();
    let root = sent(&app, &author, channel, input(Uuid::new_v4(), "Root")).await;
    sent(&app, &author, channel, reply_input(Uuid::new_v4(), &root)).await;
    assert_eq!(
        page(&app, &token, channel, &[id(&root)]).await["counts"],
        json!([entry(id(&root), id(&root), 1)])
    );
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(peer)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(peer)
        .execute(&pool)
        .await
        .unwrap();
    error(
        query(&app, &token, channel, &[id(&root)]).await,
        StatusCode::NOT_FOUND,
        "channel not found",
    )
    .await;
    assert_eq!(
        page(&app, &author, channel, &[id(&root)]).await["counts"],
        json!([entry(id(&root), id(&root), 1)])
    );
}

#[fukulow_test::test]
async fn reply_counts_deny_private_guest_nonmember(pool: PgPool) {
    denial(pool, "private_guest").await;
}
