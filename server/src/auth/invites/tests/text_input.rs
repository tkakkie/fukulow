use super::*;

fn accept_input() -> Value {
    json!({"token": "a".repeat(64), "email": "new@example.com", "name": "New Member",
        "password": "correct horse battery staple"})
}

async fn assert_invalid(response: Response, status: StatusCode) {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    let error = if status == StatusCode::UNAUTHORIZED {
        "invalid credentials"
    } else {
        "invalid input"
    };
    assert_eq!(body(response).await, json!({"error": error}));
}

#[fukulow_test::test]
async fn invite_nul_email_and_display_name_keep_auth_precedence_and_write_nothing(
    pool: sqlx::PgPool,
) {
    let org = org(&pool).await;
    let (_, _, _, token) = account(&pool, org, Role::Owner).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    let invitation = invite(&app, org, &token, "new@example.com", Role::Member).await;
    let before: Vec<(Uuid, String)> = sqlx::query_as("SELECT id,email FROM accounts ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    for field in ["email", "name"] {
        for nul in ["\0value", "val\0ue", "value\0"] {
            let mut input = accept_input();
            input["token"] = invitation["token"].clone();
            input[field] = json!(if field == "email" {
                format!("{nul}@example.com")
            } else {
                nul.into()
            });
            for credential in [None, Some(token.as_str()), Some("invalid")] {
                let expected = if credential == Some("invalid") {
                    StatusCode::UNAUTHORIZED
                } else {
                    StatusCode::BAD_REQUEST
                };
                assert_invalid(
                    req(
                        &app,
                        "POST",
                        &format!("/api/v1/orgs/{org}/invites/accept"),
                        credential,
                        input.clone(),
                    )
                    .await,
                    expected,
                )
                .await;
            }
            if field == "email" {
                for credential in [None, Some(token.as_str()), Some("invalid")] {
                    let expected = if credential == Some(token.as_str()) {
                        StatusCode::BAD_REQUEST
                    } else {
                        StatusCode::UNAUTHORIZED
                    };
                    assert_invalid(
                        req(
                            &app,
                            "POST",
                            &format!("/api/v1/orgs/{org}/invites"),
                            credential,
                            json!({"email":input["email"], "role":"member"}),
                        )
                        .await,
                        expected,
                    )
                    .await;
                }
            }
        }
    }
    let after: Vec<(Uuid, String)> = sqlx::query_as("SELECT id,email FROM accounts ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(after, before);
    let counts: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM invites WHERE organization_id=$1), (SELECT count(*) FROM invites WHERE organization_id=$1 AND accepted_at IS NOT NULL), (SELECT count(*) FROM users WHERE organization_id=$1), (SELECT count(*) FROM account_sessions)")
        .bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(counts, (1, 0, 1, 1));
}

#[fukulow_test::test]
async fn invite_nul_fields_skip_operation_database_and_password_work(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let (_, _, _, token) = account(&pool, org, Role::Owner).await;
    let state = AppState::for_test(pool.clone()).await;
    let captured = std::sync::Arc::new(std::sync::Mutex::new(None));
    let observed = captured.clone();
    let app = Router::new()
        .route(
            "/api/v1/orgs/{org}/invites",
            axum::routing::get(move |auth: Auth| async move {
                *observed.lock().unwrap() = Some(auth);
                StatusCode::NO_CONTENT
            }),
        )
        .with_state(state.clone());
    assert_eq!(
        req(
            &app,
            "GET",
            &format!("/api/v1/orgs/{org}/invites"),
            Some(&token),
            Value::Null
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    let auth = captured.lock().unwrap().take().unwrap();
    let account_id = auth.account_id;
    let token_hash = auth.token_hash.clone();
    state.pool.close().await;
    let response = create_invite(
        State(state.clone()),
        auth,
        ApiJson(CreateInviteRequest {
            email: "new\0@example.com".into(),
            role: Role::Member,
        }),
    )
    .await
    .unwrap_err()
    .into_response();
    assert_invalid(response, StatusCode::BAD_REQUEST).await;
    for field in ["email", "name"] {
        for signed_in in [false, true] {
            let mut input = accept_input();
            input[field] = json!(if field == "email" {
                "new\0@example.com"
            } else {
                "New\0Member"
            });
            let input: AcceptInviteRequest = serde_json::from_value(input).unwrap();
            let auth = InviteAuth(signed_in.then(|| AccountAuth {
                account_id,
                token_hash: token_hash.clone(),
            }));
            let response = accept_invite(State(state.clone()), auth, Ok(Path(org)), ApiJson(input))
                .await
                .unwrap_err()
                .into_response();
            assert_invalid(response, StatusCode::BAD_REQUEST).await;
        }
    }
}

#[tokio::test]
async fn nul_invite_token_keeps_404_without_database_work() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let app = crate::app(AppState::with_test_pool(pool.clone()));
    pool.close().await;
    let mut input = accept_input();
    input["token"] = json!(format!("{}\0", "a".repeat(63)));
    let response = req(
        &app,
        "POST",
        &format!("/api/v1/orgs/{}/invites/accept", Uuid::new_v4()),
        None,
        input,
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(body(response).await, json!({"error":"invite_unavailable"}));
}
