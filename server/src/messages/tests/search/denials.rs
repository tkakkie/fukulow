use super::*;
use crate::messages::tests::authors::{deactivate, grant, revoke, role};

#[fukulow_test::test]
async fn search_denies_foreign_organizations_even_with_the_same_channel_id(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let foreign = organization(&f.pools.admin).await;
    let other = Uuid::new_v4();
    let token = member(&f.pools.admin, foreign, other).await;
    channel(&f.pools.admin, foreign, f.public, other, false).await;
    let own = f.post(f.public, "shared term own").await;
    let other = sent(
        &f.app,
        &token,
        f.public,
        input(Uuid::new_v4(), "shared term foreign"),
    )
    .await;
    assert_eq!(
        ids(&page(&f, &f.token, "shared term", None, None).await),
        [id(&own)]
    );
    let response = get(
        &f.app,
        foreign,
        &token,
        Some("shared term"),
        Some(f.public),
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(ids(&body(response).await), [id(&other)]);
    error(
        get(&f.app, foreign, &f.token, Some("shared term"), None, None).await,
        StatusCode::NOT_FOUND,
        "organization_unavailable",
    )
    .await;
}

#[fukulow_test::test]
async fn search_denies_private_nonmembers_and_ungranted_guests_with_grant_controls(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let private = f.channel(true).await;
    let confidential = id(&f.post(private, "confidential").await);
    let public = id(&f.post(f.public, "public material").await);
    assert_eq!(
        ids(&page(&f, &f.token, "confidential", None, None).await),
        [confidential]
    );
    for actor_role in ["member", "owner", "admin", "guest"] {
        let actor = Uuid::new_v4();
        let token = member(&f.pools.admin, f.org, actor).await;
        role(&f.pools.admin, f.org, actor, actor_role).await;
        assert!(ids(&page(&f, &token, "confidential", None, None).await).is_empty());
        for inaccessible in [private, Uuid::new_v4()] {
            error(
                get(
                    &f.app,
                    f.org,
                    &token,
                    Some("confidential"),
                    Some(inaccessible),
                    None,
                )
                .await,
                StatusCode::NOT_FOUND,
                "channel not found",
            )
            .await;
        }
        grant(&f.pools.admin, f.org, private, actor).await;
        assert_eq!(
            ids(&page(&f, &token, "confidential", Some(private), None).await),
            [confidential]
        );
        if actor_role == "guest" {
            assert!(ids(&page(&f, &token, "public material", None, None).await).is_empty());
            error(
                get(
                    &f.app,
                    f.org,
                    &token,
                    Some("public material"),
                    Some(f.public),
                    None,
                )
                .await,
                StatusCode::NOT_FOUND,
                "channel not found",
            )
            .await;
            grant(&f.pools.admin, f.org, f.public, actor).await;
        }
        assert_eq!(
            ids(&page(&f, &token, "public material", Some(f.public), None).await),
            [public]
        );
    }
}

#[fukulow_test::test]
async fn search_requires_dm_participation_and_current_grant(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let peer = Uuid::new_v4();
    let peer_token = member(&f.pools.admin, f.org, peer).await;
    let response = request(
        &f.app,
        "POST",
        "/api/v1/dms",
        &f.token,
        json!({"member_id":peer}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let dm = id(&body(response).await);
    let message = id(&f.post(dm, "private conversation").await);
    role(&f.pools.admin, f.org, peer, "guest").await;
    for token in [&f.token, &peer_token] {
        let page = page(&f, token, "conversation", Some(dm), None).await;
        assert_eq!(ids(&page), [message]);
        assert_eq!(page["hits"][0]["channel_kind"], "dm");
    }
    let outsider = Uuid::new_v4();
    let outsider_token = member(&f.pools.admin, f.org, outsider).await;
    role(&f.pools.admin, f.org, outsider, "owner").await;
    assert!(ids(&page(&f, &outsider_token, "conversation", None, None).await).is_empty());
    error(
        get(
            &f.app,
            f.org,
            &outsider_token,
            Some("conversation"),
            Some(dm),
            None,
        )
        .await,
        StatusCode::NOT_FOUND,
        "channel not found",
    )
    .await;
    deactivate(&f.pools.admin, f.org, peer, true).await;
    assert!(ids(&page(&f, &peer_token, "conversation", None, None).await).is_empty());
    assert_eq!(
        ids(&page(&f, &f.token, "conversation", None, None).await),
        [message]
    );
}

#[fukulow_test::test]
async fn search_rechecks_visibility_between_pages_and_binds_cursor_to_member_query_and_filter(
    pool: PgPool,
) {
    let f = Fixture::new(pool).await;
    let private = f.channel(true).await;
    let actor = Uuid::new_v4();
    let actor_token = member(&f.pools.admin, f.org, actor).await;
    grant(&f.pools.admin, f.org, private, actor).await;
    bulk(&f, private, 1..=24, "needle", "1 minute", false).await;
    bulk(&f, f.public, 1..=3, "needle", "1 hour", false).await;

    let first = page(&f, &actor_token, "needle", None, None).await;
    assert_eq!(ids(&first).len(), 20);
    let cursor = first["next_cursor"].as_str().unwrap();
    let control = page(&f, &actor_token, "NEEDLE", None, Some(cursor)).await;
    assert_eq!(ids(&control).len(), 7);
    let scoped = page(&f, &actor_token, "needle", Some(private), None).await;
    let scoped_cursor = scoped["next_cursor"].as_str().unwrap();
    let own = page(&f, &f.token, "needle", None, None).await;
    assert_eq!(
        ids(&page(&f, &f.token, "needle", None, own["next_cursor"].as_str()).await).len(),
        7
    );
    for (token, q, filter, continuation) in [
        (f.token.as_str(), "needle", None, cursor),
        (actor_token.as_str(), "needles", None, cursor),
        (actor_token.as_str(), "needle", Some(private), cursor),
        (actor_token.as_str(), "needle", None, "garbage"),
        (actor_token.as_str(), "needle", None, &"00".repeat(32)),
    ] {
        error(
            get(&f.app, f.org, token, Some(q), filter, Some(continuation)).await,
            StatusCode::BAD_REQUEST,
            "invalid_cursor",
        )
        .await;
    }

    revoke(&f.pools.admin, f.org, private, actor).await;
    let second = page(&f, &actor_token, "needle", None, Some(cursor)).await;
    let public = page(&f, &actor_token, "needle", Some(f.public), None).await;
    assert_eq!(ids(&second), ids(&public));
    assert_eq!(ids(&second).len(), 3);
    assert_eq!(second["next_cursor"], Value::Null);
    error(
        get(
            &f.app,
            f.org,
            &actor_token,
            Some("needle"),
            Some(private),
            Some(scoped_cursor),
        )
        .await,
        StatusCode::NOT_FOUND,
        "channel not found",
    )
    .await;
}

async fn with_captured_auth(f: &Fixture, auth: Auth) -> Response {
    search(
        State(AppState::with_test_pool(f.pools.app.clone())),
        Extension(SearchEngine::D3r(D3rEngine)),
        auth,
        Ok(Query(
            serde_json::from_value::<SearchQuery>(json!({"q":"needle"})).unwrap(),
        )),
    )
    .await
    .into_response()
}

#[fukulow_test::test]
async fn search_rechecks_deactivation_revision_and_demotion_after_authentication(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let actor = Uuid::new_v4();
    let token = member(&f.pools.admin, f.org, actor).await;
    let message = id(&f.post(f.public, "needle").await);
    let capture = async || membership::captured_auth(&f.pools.app, &token).await;
    assert_eq!(
        ids(&body(with_captured_auth(&f, capture().await).await).await),
        [message]
    );
    let inactive = capture().await;
    let stale = capture().await;
    deactivate(&f.pools.admin, f.org, actor, false).await;
    error(
        with_captured_auth(&f, inactive).await,
        StatusCode::NOT_FOUND,
        "organization_unavailable",
    )
    .await;
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
        .bind(f.org)
        .bind(actor)
        .execute(&f.pools.admin)
        .await
        .unwrap();
    error(
        with_captured_auth(&f, stale).await,
        StatusCode::NOT_FOUND,
        "organization_unavailable",
    )
    .await;
    assert_eq!(
        ids(&page(&f, &token, "needle", None, None).await),
        [message]
    );

    let demoted = capture().await;
    role(&f.pools.admin, f.org, actor, "guest").await;
    let response = with_captured_auth(&f, demoted).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(ids(&body(response).await).is_empty());
    grant(&f.pools.admin, f.org, f.public, actor).await;
    assert_eq!(
        ids(&page(&f, &token, "needle", None, None).await),
        [message]
    );
}

#[fukulow_test::test]
async fn search_body_fetch_rechecks_visibility_and_deletion_independently_of_candidates(
    pool: PgPool,
) {
    use crate::messages::search::{CandidatePage, fetch_hits};

    let f = Fixture::new(pool).await;
    let private = f.channel(true).await;
    let actor = Uuid::new_v4();
    let token = member(&f.pools.admin, f.org, actor).await;
    let live = f
        .post(f.public, &format!("needle @{{member:{actor}}}"))
        .await;
    let hidden = f.post(private, "needle hidden").await;
    let deleted = f.post(f.public, "needle deleted").await;
    let deleted_id = id(&deleted);
    sqlx::query("UPDATE messages SET deleted=true WHERE organization_id=$1 AND id=$2")
        .bind(f.org)
        .bind(deleted_id)
        .execute(&f.pools.admin)
        .await
        .unwrap();
    let auth = membership::captured_auth(&f.pools.app, &token).await;
    let hits = crate::database::organization_read_only(&f.pools.app, f.org, async |tx| {
        let page = CandidatePage {
            candidates: [&hidden, &deleted, &live]
                .into_iter()
                .map(|item| (id(item), item["created_at"].as_str().unwrap().to_owned()))
                .collect(),
            next_cursor: Some("next".to_owned()),
            range_start: "2000-01-01T00:00:00.000000Z".to_owned(),
        };
        fetch_hits(tx, f.org, (actor, auth.membership_revision), None, &page)
            .await
            .map_err(ApiError::from)
    })
    .await
    .unwrap();
    let value = serde_json::to_value(hits).unwrap();
    assert_eq!(value, json!([{"message": live, "channel_kind": "channel"}]));
    assert_eq!(
        value[0]["message"]["mentions"][0]["member_id"],
        actor.to_string()
    );
}
