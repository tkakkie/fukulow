use super::*;
use axum::extract::FromRequestParts;

#[sqlx::test]
async fn surrounding_channel_name_whitespace_is_rejected_without_writes(pool: PgPool) {
    let app = router(&pool);
    let organization_id = organization(&pool).await;
    let token = member(&pool, organization_id, Uuid::new_v4(), "member").await;
    create(&app, &token, "existing", "private").await;
    let before = list(&app, &token).await;
    for visibility in ["public", "private"] {
        for name in [
            " leading",
            "trailing ",
            " both ",
            "\u{3000}wide",
            "wide\u{3000}",
            "\u{a0}nbsp",
            "nbsp\u{a0}",
            "\u{2003}em",
            "em\u{2003}",
            "\ttab",
            "newline\n",
            " ",
            "\u{3000}",
            " existing",
            "existing ",
            " existing ",
        ] {
            assert_ne!(name, name.trim());
            let response = request(
                &app,
                "POST",
                "/api/v1/channels",
                &token,
                json!({"name": name, "visibility": visibility}),
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{name:?}");
            assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(body(response).await, json!({"error": "invalid input"}));
            assert_eq!(list(&app, &token).await, before);
            let counts: (i64, i64) = sqlx::query_as(
                "SELECT (SELECT count(*) FROM channels WHERE organization_id = $1), \
                        (SELECT count(*) FROM channel_members WHERE organization_id = $1)",
            )
            .bind(organization_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(counts, (1, 1));
        }
    }
}

#[sqlx::test]
async fn channel_name_whitespace_preserves_internal_whitespace_and_empty_names(pool: PgPool) {
    let app = router(&pool);
    for visibility in ["public", "private"] {
        let organization_id = organization(&pool).await;
        let token = member(&pool, organization_id, Uuid::new_v4(), "member").await;
        for name in ["a b", "a\u{3000}b", "a\u{a0}b", "a\u{2003}b", ""] {
            create(&app, &token, name, visibility).await;
        }
    }
}

#[sqlx::test]
async fn surrounding_channel_name_whitespace_is_rejected_before_opening_transaction(pool: PgPool) {
    let organization_id = organization(&pool).await;
    let token = member(&pool, organization_id, Uuid::new_v4(), "member").await;
    let state = AppState::for_test(pool.clone());
    let (mut parts, _) = Request::post("/api/v1/channels")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
        .into_parts();
    let auth = Auth::from_request_parts(&mut parts, &state).await.unwrap();
    // Auth may read the session; semantic validation must precede even BEGIN.
    pool.close().await;
    let response = create_channel(
        State(state),
        auth,
        ApiJson(CreateChannelRequest {
            name: "\u{3000}name ".into(),
            visibility: ChannelVisibility::Private,
        }),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body(response).await, json!({"error": "invalid input"}));
}
