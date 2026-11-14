use super::*;

#[fukulow_test::test]
async fn nul_message_body_and_topic_keep_401_precedence_and_write_nothing(pool: PgPool) {
    let (app, org, _, channel_id, token) = fixture(&pool).await;
    for field in ["body", "topic_name"] {
        let mut value = input(Uuid::new_v4(), "valid body");
        value[field] = json!("text\0input");
        for credential in [None, Some("invalid"), Some(token.as_str())] {
            let mut req =
                Request::post(format!("/api/v1/orgs/{org}/channels/{channel_id}/messages"))
                    .header(header::CONTENT_TYPE, "application/json");
            if let Some(token) = credential {
                req = req.header(header::AUTHORIZATION, format!("Bearer {token}"));
            }
            let response = app
                .clone()
                .oneshot(req.body(Body::from(value.to_string())).unwrap())
                .await
                .unwrap();
            let (status, error) = if credential == Some(token.as_str()) {
                (StatusCode::BAD_REQUEST, "invalid input")
            } else {
                (StatusCode::UNAUTHORIZED, "invalid credentials")
            };
            assert_eq!(response.status(), status);
            assert_eq!(body(response).await, json!({"error": error}));
        }
    }
    let counts: (i64,i64,i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM messages WHERE organization_id=$1), (SELECT count(*) FROM topics WHERE organization_id=$1), (SELECT count(*) FROM channel_message_sequences WHERE organization_id=$1)")
        .bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(counts, (0, 0, 0));
}

#[fukulow_test::test]
async fn nul_message_fields_skip_operation_database_after_authentication(pool: PgPool) {
    let (_, org, _, channel_id, token) = fixture(&pool).await;
    let state = AppState::for_test(pool.clone()).await;
    let captured = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = captured.clone();
    let app = Router::new()
        .route(
            "/api/v1/orgs/{org}/channels",
            axum::routing::get(move |auth: DeferredOrganizationAuth| async move {
                observed.lock().unwrap().push(auth);
                StatusCode::NO_CONTENT
            }),
        )
        .with_state(state.clone());
    for _ in 0..2 {
        assert_eq!(
            request(&app, "GET", "/api/v1/channels", &token, Value::Null)
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
    }
    state.pool.close().await;
    for field in ["body", "topic_name"] {
        let auth = captured.lock().unwrap().pop().unwrap();
        assert!(auth.0.is_some());
        let mut value = input(Uuid::new_v4(), "valid body");
        value[field] = json!("text\0input");
        let response = send_message(
            State(state.clone()),
            auth,
            Ok(Path((org, channel_id))),
            ApiJson(serde_json::from_value(value).unwrap()),
        )
        .await
        .unwrap_err()
        .into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body(response).await, json!({"error":"invalid input"}));
    }
}
