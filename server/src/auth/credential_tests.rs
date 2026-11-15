use super::*;
use axum::body::{Body, to_bytes};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tower::ServiceExt;

pub(super) async fn fixture(pool: sqlx::PgPool) -> AppState {
    let state = AppState::for_test(pool).await;
    setup_with_workers(
        state.clone(),
        SetupRequest {
            setup_token: Some("setup-token-test-only".into()),
            organization_name: "Entropy test".into(),
            name: "Owner".into(),
            email: "owner@example.com".into(),
            password: "correct horse battery staple".into(),
        },
        &PASSWORD_WORKERS,
    )
    .await
    .unwrap();
    state
}

fn app_with_entropy(
    state: AppState,
    calls: Arc<AtomicUsize>,
    fail: bool,
    partial: bool,
) -> axum::Router {
    axum::Router::new()
        .route(
            "/api/v1/native/session",
            axum::routing::post(move |State(state), peer, headers, ApiJson(input)| {
                let calls = calls.clone();
                async move {
                    sign_in_with_entropy(
                        state,
                        peer,
                        headers,
                        input,
                        &PASSWORD_WORKERS,
                        move |bytes| {
                            calls.fetch_add(1, Ordering::SeqCst);
                            assert_eq!(bytes.len(), 32);
                            if !fail || partial {
                                for (byte, value) in bytes.iter_mut().zip(0u8..) {
                                    *byte = value;
                                }
                            }
                            if fail {
                                Err(ApiError(
                                    StatusCode::INTERNAL_SERVER_ERROR,
                                    "internal error",
                                    None,
                                ))
                            } else {
                                Ok(())
                            }
                        },
                    )
                    .await
                    .map(IntoResponse::into_response)
                }
            }),
        )
        .with_state(state)
}

async fn sign_in_request(app: axum::Router) -> Response {
    app.oneshot(
        Request::post("/api/v1/native/session")
            .extension(ConnectInfo(
                "192.0.2.1:1234".parse::<std::net::SocketAddr>().unwrap(),
            ))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({"email": "owner@example.com", "password": "correct horse battery staple"})
                    .to_string(),
            ))
            .unwrap(),
    )
    .await
    .unwrap()
}

#[fukulow_test::test]
async fn session_entropy_failure_returns_500_without_session_or_fallback(pool: sqlx::PgPool) {
    let state = fixture(pool.clone()).await;
    for partial in [false, true] {
        let calls = Arc::new(AtomicUsize::new(0));
        let response = sign_in_request(app_with_entropy(
            state.clone(),
            calls.clone(),
            true,
            partial,
        ))
        .await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert!(!response.headers().contains_key(header::SET_COOKIE));
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"error": "internal error"})
        );
        let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM account_sessions")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(sessions, 0);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}

#[fukulow_test::test]
async fn session_entropy_success_encodes_every_byte_once(pool: sqlx::PgPool) {
    let state = fixture(pool.clone()).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let response = sign_in_request(app_with_entropy(state, calls.clone(), false, false)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let session: Value = serde_json::from_slice(&body).unwrap();
    let expected = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    assert_eq!(session["token"], expected);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let stored: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM account_sessions WHERE token_hash = sha256(convert_to($1, 'UTF8')))")
        .bind(expected).fetch_one(&pool).await.unwrap();
    assert!(stored);
}

#[fukulow_test::test]
async fn formerly_implicit_executor_and_begin_acquisitions_are_counted(pool: sqlx::PgPool) {
    use axum::extract::FromRequestParts;
    let app = AppState::for_test(pool).await;
    let ((), count) = crate::database::test_acquisitions(async {
        let (mut parts, ()) = axum::http::Request::builder()
            .header(
                axum::http::header::AUTHORIZATION,
                format!("Bearer {}", "a".repeat(64)),
            )
            .body(())
            .unwrap()
            .into_parts();
        // AccountAuth formerly passed &PgPool to fetch_optional. Even this
        // unauthorized lookup must count its acquisition.
        assert!(
            super::AccountAuth::from_request_parts(&mut parts, &app)
                .await
                .is_err()
        );
        let tx = crate::database::begin(&app.pool).await.unwrap();
        tx.rollback().await.unwrap();
        assert!(crate::database::ready(&app.pool).await);
    })
    .await;
    assert_eq!(count, 3);
}

#[fukulow_test::test]
async fn setup_status_and_both_setup_checks_use_measured_acquisitions(pool: sqlx::PgPool) {
    let state = AppState::for_test(pool).await;
    for setup_required in [true, false] {
        let (response, count) =
            crate::database::test_acquisitions(setup_status(State(state.clone()))).await;
        assert_eq!(count, 1);
        let response = response.unwrap();
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"setup_required": setup_required})
        );
        let (result, count) = crate::database::test_acquisitions(setup_with_workers(
            state.clone(),
            SetupRequest {
                setup_token: Some("setup-token-test-only".into()),
                organization_name: "Measured setup".into(),
                name: "Owner".into(),
                email: "owner@example.com".into(),
                password: "correct horse battery staple".into(),
            },
            &PASSWORD_WORKERS,
        ))
        .await;
        if setup_required {
            assert_eq!(result.unwrap().status(), StatusCode::CREATED);
            // One fast-path checkout plus the transaction checkout. The locked
            // existence recheck must continue using that transaction's connection.
            assert_eq!(count, 2);
        } else {
            assert_eq!(result.unwrap_err().0, StatusCode::CONFLICT);
            assert_eq!(count, 1);
        }
    }
}

#[fukulow_test::test]
async fn sign_out_spawned_revocation_acquisition_is_counted(pool: sqlx::PgPool) {
    use axum::extract::FromRequestParts;
    let state = fixture(pool.clone()).await;
    let response = sign_in_request(app_with_entropy(
        state.clone(),
        Arc::new(AtomicUsize::new(0)),
        false,
        false,
    ))
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let session: Value = serde_json::from_slice(&body).unwrap();
    let (mut parts, ()) = Request::builder()
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", session["token"].as_str().unwrap()),
        )
        .body(())
        .unwrap()
        .into_parts();
    // Resolve AccountAuth outside the counter scope so the assertion observes
    // only the checkout inside the detached revocation task.
    let auth = AccountAuth::from_request_parts(&mut parts, &state)
        .await
        .unwrap();
    let hash = auth.token_hash.clone();
    let (response, count) =
        crate::database::test_acquisitions(sign_out(State(state), Ok(auth))).await;
    assert_eq!(response.unwrap().status(), StatusCode::NO_CONTENT);
    assert_eq!(count, 1);
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM account_sessions WHERE token_hash = $1)")
            .bind(hash)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!exists);
}
