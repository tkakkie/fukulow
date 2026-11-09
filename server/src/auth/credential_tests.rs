use super::*;
use axum::body::{Body, to_bytes};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tower::ServiceExt;

async fn fixture(pool: sqlx::PgPool) -> AppState {
    let state = AppState::for_test(pool);
    setup_with_workers(
        state.clone(),
        SetupRequest {
            setup_token: None,
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
            "/api/v1/session",
            axum::routing::post(move |State(state), peer, headers, ApiJson(input)| {
                let calls = calls.clone();
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
            }),
        )
        .with_state(state)
}

async fn sign_in_request(app: axum::Router) -> Response {
    app.oneshot(
        Request::post("/api/v1/session")
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

#[sqlx::test]
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
        let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(sessions, 0);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}

#[sqlx::test]
async fn session_entropy_success_encodes_every_byte_once(pool: sqlx::PgPool) {
    let state = fixture(pool.clone()).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let response = sign_in_request(app_with_entropy(state, calls.clone(), false, false)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    let session: Value = serde_json::from_slice(&body).unwrap();
    let organization = session["identity"]["organization"]["organization_id"]
        .as_str()
        .unwrap();
    let expected =
        format!("{organization}.000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    assert_eq!(session["token"], expected);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let stored: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM sessions WHERE organization_id = $1 AND token_hash = sha256(convert_to($2, 'UTF8')))")
        .bind(organization.parse::<Uuid>().unwrap()).bind(expected).fetch_one(&pool).await.unwrap();
    assert!(stored);
}
