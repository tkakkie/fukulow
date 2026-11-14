use super::*;
use axum::body::{Body, to_bytes};
use serde_json::{Value, json};
use tower::ServiceExt;

fn setup_input() -> Value {
    json!({"setup_token": "setup-token-test-only", "organization_name": "Organization",
        "name": "Owner", "email": "owner@example.com", "password": "correct horse battery staple"})
}

fn request(path: &str, input: &Value) -> Request {
    Request::post(path)
        .extension(ConnectInfo(
            "192.0.2.1:1234".parse::<std::net::SocketAddr>().unwrap(),
        ))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(input.to_string()))
        .unwrap()
}

async fn assert_error(response: Response, status: StatusCode, error: &str) {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    let bytes = to_bytes(response.into_body(), 1024).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap(),
        json!({"error": error})
    );
}

#[test]
fn shared_text_validator_rejects_nul_and_preserves_other_text() {
    for value in ["\0", "\0start", "mid\0dle", "end\0"] {
        let error = validate_text(value).unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert_eq!(error.1, "invalid input");
    }
    for value in ["", " \t\n", "日本語😀", "a\u{1}b"] {
        assert!(validate_text(value).is_ok());
    }
}

#[tokio::test]
async fn setup_nul_fields_follow_token_gate_and_skip_database_and_hashing() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let state = AppState::with_test_pool(pool.clone());
    pool.close().await;
    let app = axum::Router::new()
        .route(
            "/api/v1/setup",
            axum::routing::post(|State(state), ApiJson(input)| {
                setup_with_hash(state, input, |_| async {
                    panic!("invalid text must never invoke password hashing")
                })
            }),
        )
        .with_state(state);
    for field in ["email", "name", "organization_name"] {
        for nul in ["\0value", "val\0ue", "value\0"] {
            for token in [Some("setup-token-test-only"), Some("incorrect"), None] {
                let mut input = setup_input();
                input[field] = json!(if field == "email" {
                    format!("{nul}@example.com")
                } else {
                    nul.into()
                });
                input["setup_token"] = json!(token);
                let response = app
                    .clone()
                    .oneshot(request("/api/v1/setup", &input))
                    .await
                    .unwrap();
                let (status, error) = if token == Some("setup-token-test-only") {
                    (StatusCode::BAD_REQUEST, "invalid input")
                } else {
                    (StatusCode::UNAUTHORIZED, "invalid credentials")
                };
                assert_error(response, status, error).await;
            }
        }
    }
}

#[fukulow_test::test]
async fn setup_nul_fields_write_nothing(pool: sqlx::PgPool) {
    let app = crate::app(AppState::for_test(pool.clone()).await);
    for field in ["email", "name", "organization_name"] {
        let mut input = setup_input();
        input[field] = json!(format!("{}\0", input[field].as_str().unwrap()));
        assert_error(
            app.clone()
                .oneshot(request("/api/v1/setup", &input))
                .await
                .unwrap(),
            StatusCode::BAD_REQUEST,
            "invalid input",
        )
        .await;
    }
    let counts: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM organizations), (SELECT count(*) FROM accounts), (SELECT count(*) FROM users), (SELECT count(*) FROM account_sessions)")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(counts, (0, 0, 0, 0));
}

#[tokio::test]
async fn web_and_native_nul_email_precedes_throttle_password_and_database() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let state = AppState::with_test_pool(pool.clone());
    pool.close().await;
    static WORKERS: PasswordWorkers = PasswordWorkers::new();
    let _running = WORKERS.running.acquire_many(4).await.unwrap();
    let _waiting = WORKERS.waiting.acquire_many(32).await.unwrap();
    let app = tests::app_with_workers_and_entropy(state.clone(), &WORKERS, |_| {
        panic!("invalid text must not consume session-token entropy")
    });
    for path in ["/api/v1/session", "/api/v1/native/session"] {
        // A full IP budget makes even a temporary reservation observable as 429.
        let reservations: Vec<_> = (0..20)
            .map(|_| {
                state
                    .sign_in_throttle
                    .begin("192.0.2.1".parse().unwrap())
                    .unwrap()
            })
            .collect();
        for email in [
            "\0owner@example.com",
            "own\0er@example.com",
            "owner@example.com\0",
        ] {
            let response = app
                .clone()
                .oneshot(request(path, &json!({"email":email,"password":"password"})))
                .await
                .unwrap();
            assert_error(response, StatusCode::BAD_REQUEST, "invalid input").await;
            assert_eq!(state.sign_in_throttle.pending_counts(), (20, 0));
        }
        drop(reservations);
        assert_eq!(state.sign_in_throttle.pending_counts(), (0, 0));
        // Rejection also leaves an unused failure budget available.
        let reservations: Vec<_> = (0..20)
            .map(|_| {
                state
                    .sign_in_throttle
                    .begin("192.0.2.1".parse().unwrap())
                    .unwrap()
            })
            .collect();
        drop(reservations);
    }
}

#[fukulow_test::test]
async fn nul_password_remains_usable_for_setup_and_both_sign_in_endpoints(pool: sqlx::PgPool) {
    let app = crate::app(AppState::for_test(pool.clone()).await);
    let mut input = setup_input();
    input["password"] = json!("correct horse\0battery staple");
    let response = app
        .clone()
        .oneshot(request("/api/v1/setup", &input))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    for path in ["/api/v1/session", "/api/v1/native/session"] {
        let response = app
            .clone()
            .oneshot(request(
                path,
                &json!({"email":input["email"], "password":input["password"]}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
