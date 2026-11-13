use super::*;
use crate::auth::{self, SignInThrottle};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::Request,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

const PASSWORD: &str = "correct horse battery staple";
const NEW_PASSWORD: &str = "new correct horse battery staple";
const OPERATIONS: [(&str, &str); 2] = [
    ("PUT", "/api/v1/me/password"),
    ("POST", "/api/v1/me/sessions/revoke-others"),
];

struct Fixture {
    state: AppState,
    app: Router,
    account: Uuid,
    current: String,
    cookie: String,
    bearer: String,
    other: String,
}

fn token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

async fn fixture(pool: &PgPool) -> Fixture {
    let state = AppState {
        cookie_secure: false,
        ..AppState::for_test(pool.clone()).await
    };
    let account = Uuid::new_v4();
    let other = Uuid::new_v4();
    let hash = auth::hash_password(PASSWORD.into(), &auth::PASSWORD_WORKERS)
        .await
        .unwrap();
    for (id, email) in [(account, "owner@example.com"), (other, "other@example.com")] {
        sqlx::query("INSERT INTO accounts(id,email,password_hash) VALUES ($1,$2,$3)")
            .bind(id)
            .bind(email)
            .bind(&hash)
            .execute(pool)
            .await
            .unwrap();
    }
    let current = token();
    let cookie = token();
    let bearer = token();
    let other_token = token();
    for (id, token) in [
        (account, &current),
        (account, &cookie),
        (account, &bearer),
        (other, &other_token),
    ] {
        sqlx::query("INSERT INTO account_sessions(account_id,token_hash) VALUES ($1,$2)")
            .bind(id)
            .bind(Sha256::digest(token.as_bytes()).to_vec())
            .execute(pool)
            .await
            .unwrap();
    }
    Fixture {
        app: crate::app(state.clone()),
        state,
        account,
        current,
        cookie,
        bearer,
        other: other_token,
    }
}

fn body(path: &str, password: &str) -> Value {
    if path.ends_with("password") {
        json!({"current_password": password, "new_password": NEW_PASSWORD})
    } else {
        json!({"current_password": password})
    }
}

fn request(method: &str, path: &str, token: Option<&str>, cookie: bool, body: Value) -> Request {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .extension(ConnectInfo(
            "192.0.2.1:1234".parse::<std::net::SocketAddr>().unwrap(),
        ))
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = if cookie {
            builder.header(header::COOKIE, format!("fukulow_session={token}"))
        } else {
            builder.header(header::AUTHORIZATION, format!("Bearer {token}"))
        };
    }
    builder.body(Body::from(body.to_string())).unwrap()
}

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    cookie: bool,
    input: Value,
) -> Response {
    app.clone()
        .oneshot(request(method, path, token, cookie, input))
        .await
        .unwrap()
}

async fn error(response: Response, status: StatusCode, code: &str) {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap(),
        json!({"error":code})
    );
}

async fn snapshot(pool: &PgPool) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_object('accounts',(SELECT jsonb_agg(a ORDER BY id) FROM accounts a),'sessions',(SELECT jsonb_agg(s ORDER BY token_hash) FROM account_sessions s))")
        .fetch_one(pool).await.unwrap()
}

fn app_with_workers(state: AppState, workers: &'static PasswordWorkers) -> Router {
    let routes = Router::new()
        .route(
            "/api/v1/me/password",
            axum::routing::put(move |State(state), auth, peer, headers, ApiJson(input)| {
                change_password_with_workers(state, auth, peer, headers, input, workers)
            }),
        )
        .route(
            "/api/v1/me/sessions/revoke-others",
            axum::routing::post(
                move |State(state),
                      auth,
                      peer,
                      headers,
                      ApiJson(input): ApiJson<RevokeOtherSessionsRequest>| {
                    secure_account(
                        state,
                        auth,
                        peer,
                        headers,
                        input.current_password,
                        None,
                        workers,
                    )
                },
            ),
        )
        .with_state(state.clone());
    auth::tests::app_with_workers(state, workers).merge(routes)
}

#[sqlx::test]
async fn security_wrong_password_is_403_preserves_all_accounts_and_sessions(pool: PgPool) {
    let f = fixture(&pool).await;
    let before = snapshot(&pool).await;
    for (method, path) in OPERATIONS {
        error(
            call(
                &f.app,
                method,
                path,
                Some(&f.current),
                false,
                body(path, "wrong password"),
            )
            .await,
            StatusCode::FORBIDDEN,
            "current_password_incorrect",
        )
        .await;
        assert_eq!(snapshot(&pool).await, before);
        for token in [&f.current, &f.cookie, &f.bearer, &f.other] {
            assert_eq!(
                call(&f.app, "GET", "/api/v1/me", Some(token), false, Value::Null)
                    .await
                    .status(),
                StatusCode::OK
            );
        }
    }
    // Exactly two failures, and no pending reservations; successes never reset failures.
    assert_eq!(f.state.sign_in_throttle.pending_counts(), (0, 0));
    for _ in 0..3 {
        let mut attempt = f
            .state
            .sign_in_throttle
            .begin("192.0.2.2".parse().unwrap())
            .unwrap();
        attempt.account("owner@example.com".into()).unwrap();
        attempt.failed();
    }
    let mut refused = f
        .state
        .sign_in_throttle
        .begin("192.0.2.3".parse().unwrap())
        .unwrap();
    assert!(refused.account("owner@example.com".into()).is_err());
}

#[sqlx::test]
async fn security_requires_valid_unexpired_session_before_password_or_body(pool: PgPool) {
    let f = fixture(&pool).await;
    sqlx::query(
        "UPDATE account_sessions SET expires_at = now() - interval '1 second' WHERE token_hash=$1",
    )
    .bind(Sha256::digest(f.cookie.as_bytes()).to_vec())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM account_sessions WHERE token_hash=$1")
        .bind(Sha256::digest(f.bearer.as_bytes()).to_vec())
        .execute(&pool)
        .await
        .unwrap();
    let before = snapshot(&pool).await;
    for (method, path) in OPERATIONS {
        for credential in [
            None,
            Some("invalid"),
            Some(f.cookie.as_str()),
            Some(f.bearer.as_str()),
        ] {
            error(
                call(&f.app, method, path, credential, false, Value::Null).await,
                StatusCode::UNAUTHORIZED,
                "invalid credentials",
            )
            .await;
            assert_eq!(snapshot(&pool).await, before);
        }
    }
    assert_eq!(f.state.sign_in_throttle.pending_counts(), (0, 0));
}

#[sqlx::test]
async fn security_invalid_password_and_malformed_requests_do_not_mutate(pool: PgPool) {
    let f = fixture(&pool).await;
    let before = snapshot(&pool).await;
    for password in [
        "short".to_owned(),
        "字".repeat(11),
        "a".repeat(1025),
        "字".repeat(342),
    ] {
        error(
            call(
                &f.app,
                "PUT",
                "/api/v1/me/password",
                Some(&f.current),
                false,
                json!({"current_password": PASSWORD,"new_password":password}),
            )
            .await,
            StatusCode::BAD_REQUEST,
            "invalid_new_password",
        )
        .await;
    }
    for (method, path) in OPERATIONS {
        for password in ["".to_owned(), "a".repeat(1025)] {
            error(
                call(
                    &f.app,
                    method,
                    path,
                    Some(&f.current),
                    false,
                    body(path, &password),
                )
                .await,
                StatusCode::BAD_REQUEST,
                "invalid input",
            )
            .await;
        }
        for input in [
            json!({}),
            json!({"current_password":PASSWORD,"unexpected":true}),
            Value::Null,
        ] {
            error(
                call(&f.app, method, path, Some(&f.current), false, input).await,
                StatusCode::BAD_REQUEST,
                "invalid input",
            )
            .await;
        }
    }
    assert_eq!(snapshot(&pool).await, before);
    // Validation never spends a failure budget.
    for _ in 0..5 {
        let mut attempt = f
            .state
            .sign_in_throttle
            .begin("192.0.2.1".parse().unwrap())
            .unwrap();
        attempt.account("owner@example.com".into()).unwrap();
        attempt.failed();
    }
}

#[sqlx::test]
async fn security_success_revokes_cookie_and_bearer_preserving_current_and_other_account(
    pool: PgPool,
) {
    for (method, path) in OPERATIONS {
        let f = fixture(&pool).await;
        let before = snapshot(&pool).await;
        let response = call(
            &f.app,
            method,
            path,
            Some(&f.current),
            true,
            body(path, PASSWORD),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert!(!response.headers().contains_key(header::SET_COOKIE));
        assert!(to_bytes(response.into_body(), 1).await.unwrap().is_empty());
        for (token, cookie) in [(&f.cookie, true), (&f.bearer, false)] {
            error(
                call(
                    &f.app,
                    "GET",
                    "/api/v1/me",
                    Some(token),
                    cookie,
                    Value::Null,
                )
                .await,
                StatusCode::UNAUTHORIZED,
                "invalid credentials",
            )
            .await;
        }
        for token in [&f.current, &f.other] {
            assert_eq!(
                call(&f.app, "GET", "/api/v1/me", Some(token), false, Value::Null)
                    .await
                    .status(),
                StatusCode::OK
            );
        }
        let after = snapshot(&pool).await;
        for account in before["accounts"].as_array().unwrap() {
            let changed = after["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["id"] == account["id"])
                .unwrap();
            if account["id"] != json!(f.account) || method == "POST" {
                assert_eq!(changed, account);
            } else {
                assert_ne!(changed["password_hash"], account["password_hash"]);
            }
        }
        for session in after["sessions"].as_array().unwrap() {
            assert!(before["sessions"].as_array().unwrap().contains(session));
        }
        let login = call(&f.app,"POST","/api/v1/native/session",None,false,
            json!({"email":"owner@example.com","password": if method == "PUT" { NEW_PASSWORD } else { PASSWORD }})).await;
        assert_eq!(login.status(), StatusCode::OK);
        if method == "PUT" {
            error(
                call(
                    &f.app,
                    "POST",
                    "/api/v1/session",
                    None,
                    false,
                    json!({"email":"owner@example.com","password":PASSWORD}),
                )
                .await,
                StatusCode::UNAUTHORIZED,
                "invalid credentials",
            )
            .await;
        }
        sqlx::query("DELETE FROM account_sessions")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM accounts")
            .execute(&pool)
            .await
            .unwrap();
    }
}

#[sqlx::test]
async fn security_database_error_rolls_back_password_and_every_session(pool: PgPool) {
    let f = fixture(&pool).await;
    sqlx::raw_sql("CREATE FUNCTION refuse_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected deletion failure'; END $$; CREATE TRIGGER refuse_session_delete BEFORE DELETE ON account_sessions FOR EACH ROW EXECUTE FUNCTION refuse_session_delete()")
        .execute(&pool).await.unwrap();
    let before = snapshot(&pool).await;
    for (method, path) in OPERATIONS {
        error(
            call(
                &f.app,
                method,
                path,
                Some(&f.current),
                false,
                body(path, PASSWORD),
            )
            .await,
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal error",
        )
        .await;
        assert_eq!(snapshot(&pool).await, before);
    }
}

mod concurrency;
mod throttle;

#[sqlx::test]
async fn password_change_accepts_setup_character_and_utf8_byte_boundaries(pool: PgPool) {
    let f = fixture(&pool).await;
    let mut current = PASSWORD.to_owned();
    for next in [
        "a".repeat(12),
        "字".repeat(12),
        "a".repeat(1024),
        format!("{}a", "字".repeat(341)),
    ] {
        let response = call(
            &f.app,
            "PUT",
            "/api/v1/me/password",
            Some(&f.current),
            false,
            json!({"current_password":current,"new_password":next}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        current = next;
    }
}

#[sqlx::test]
async fn security_body_content_type_and_size_denials_preserve_state(pool: PgPool) {
    let f = fixture(&pool).await;
    let before = snapshot(&pool).await;
    for (method, path) in OPERATIONS {
        for (content, raw, status, code) in [
            (
                "text/plain",
                "{}".to_owned(),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "expected application/json",
            ),
            (
                "application/json",
                "{".to_owned(),
                StatusCode::BAD_REQUEST,
                "invalid input",
            ),
            (
                "application/json",
                " ".repeat(17 * 1024),
                StatusCode::PAYLOAD_TOO_LARGE,
                "request body too large",
            ),
        ] {
            let request = Request::builder()
                .method(method)
                .uri(path)
                .extension(ConnectInfo(
                    "192.0.2.1:1234".parse::<std::net::SocketAddr>().unwrap(),
                ))
                .header(header::AUTHORIZATION, format!("Bearer {}", f.current))
                .header(header::CONTENT_TYPE, content)
                .body(Body::from(raw))
                .unwrap();
            error(f.app.clone().oneshot(request).await.unwrap(), status, code).await;
            assert_eq!(snapshot(&pool).await, before);
        }
    }
}
