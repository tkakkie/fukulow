#![cfg(test)]

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
    response::Response,
};
use fukulow_server::{AppState, app};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

const PASSWORD: &str = "correct horse battery staple";

fn router(pool: &PgPool) -> Router {
    app(AppState {
        pool: pool.clone(),
        cookie_secure: true,
        setup_token: None,
        sign_in_throttle: Default::default(),
        message_delivery: Default::default(),
        session_changes: Default::default(),
        session_cleanup: Default::default(),
        ws_allowed_origins: Default::default(),
    })
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    headers: &[(&str, &str)],
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .extension(axum::extract::ConnectInfo(
            "192.0.2.1:1234".parse::<std::net::SocketAddr>().unwrap(),
        ));
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    app.clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
}

async fn body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 32 * 1024).await.unwrap()).unwrap()
}

fn setup_input() -> Value {
    json!({"organization_name": "Organization A", "name": "Owner A", "email": "Owner@Example.com", "password": PASSWORD})
}

async fn setup(app: &Router) -> Value {
    let response = request(app, "POST", "/api/v1/setup", setup_input(), &[]).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    body(response).await
}

async fn sign_in(app: &Router, organization_id: &str, password: &str) -> Response {
    request(app, "POST", "/api/v1/session", json!({"organization_id": organization_id, "email": "owner@example.com", "password": password}), &[]).await
}

// Reusable fixture for later tenant denial tests. The production setup API is
// deliberately single-use; insert the second organization only through test SQL.
async fn two_organizations(pool: &PgPool, app: &Router) -> (Value, Uuid) {
    let first = setup(app).await;
    let first_id: Uuid = first["organization"]["organization_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let second_id = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (organization_id, name) VALUES ($1, 'Organization B')")
        .bind(second_id)
        .execute(pool)
        .await
        .unwrap();
    // Use the same member id and email in both organizations to catch joins
    // which accidentally omit the organization_id part of a composite key.
    sqlx::query("INSERT INTO users (organization_id, id, email, name, password_hash, role) SELECT $1, id, email, 'Owner B', password_hash, 'guest' FROM users WHERE organization_id = $2")
        .bind(second_id).bind(first_id).execute(pool).await.unwrap();
    (first, second_id)
}

async fn assert_setup_status(pool: &PgPool, setup_required: bool) {
    for setup_token in [None, Some("setup-status-test-only".into())] {
        let app = app(AppState {
            pool: pool.clone(),
            cookie_secure: true,
            setup_token,
            sign_in_throttle: Default::default(),
            message_delivery: Default::default(),
            session_changes: Default::default(),
            session_cleanup: Default::default(),
            ws_allowed_origins: Default::default(),
        });
        let response = app
            .oneshot(Request::get("/api/v1/setup").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert!(!response.headers().contains_key(header::SET_COOKIE));
        // Exact equality denies any disclosure of organization, member or token data.
        assert_eq!(
            body(response).await,
            json!({"setup_required": setup_required})
        );
    }
}

#[sqlx::test]
async fn setup_status_empty_database_is_public_and_reveals_only_boolean(pool: PgPool) {
    assert_setup_status(&pool, true).await;
    let counts: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM organizations), (SELECT count(*) FROM users), (SELECT count(*) FROM sessions)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(counts, (0, 0, 0));
}

#[sqlx::test]
async fn setup_status_after_setup_is_public_and_reveals_only_boolean(pool: PgPool) {
    setup(&router(&pool)).await;
    assert_setup_status(&pool, false).await;
    let counts: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM organizations), (SELECT count(*) FROM users), (SELECT count(*) FROM sessions)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(counts, (1, 1, 0));
}

#[sqlx::test]
async fn setup_works_once_and_is_atomic(pool: PgPool) {
    let app = router(&pool);
    let (a, b) = tokio::join!(
        request(&app, "POST", "/api/v1/setup", setup_input(), &[]),
        request(&app, "POST", "/api/v1/setup", setup_input(), &[])
    );
    let mut statuses = [a.status().as_u16(), b.status().as_u16()];
    statuses.sort();
    assert_eq!(statuses, [201, 409]);
    assert_eq!(
        request(&app, "POST", "/api/v1/setup", setup_input(), &[])
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let organization_id = body(if a.status() == StatusCode::CREATED {
        a
    } else {
        b
    })
    .await["organization"]["organization_id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let (count, hash, role): (i64, String, String) = sqlx::query_as(
        "SELECT count(*) OVER (), password_hash, role FROM users WHERE organization_id = $1",
    )
    .bind(organization_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
    assert!(hash.starts_with("$argon2id$"));
    assert!(!hash.contains(PASSWORD));
    assert_eq!(role, "owner");
}

#[tokio::test]
async fn json_rejections_use_error_body_on_setup_and_sign_in() {
    // Rejections must happen without accessing a database or password workers.
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    for (path, setup_token) in [
        ("/api/v1/setup", None),
        ("/api/v1/setup", Some("setup-token-test-only")),
        ("/api/v1/session", None),
    ] {
        let app = app(AppState {
            pool: pool.clone(),
            cookie_secure: true,
            setup_token: setup_token.map(str::to_owned),
            sign_in_throttle: Default::default(),
            message_delivery: Default::default(),
            session_changes: Default::default(),
            session_cleanup: Default::default(),
            ws_allowed_origins: Default::default(),
        });
        let valid_input = if path == "/api/v1/setup" {
            setup_input()
        } else {
            json!({"email": "owner@example.com", "password": PASSWORD})
        };
        let mut wrong_type = valid_input.clone();
        wrong_type["password"] = json!(123);
        let mut unknown_field = valid_input.clone();
        unknown_field["unexpected"] = json!(true);
        let mut oversized = valid_input.clone();
        oversized["password"] = json!("x".repeat(16 * 1024));
        for (content_type, input, status, error) in [
            (
                Some("application/json"),
                "{".into(),
                StatusCode::BAD_REQUEST,
                "invalid input",
            ),
            (
                Some("application/json"),
                String::new(),
                StatusCode::BAD_REQUEST,
                "invalid input",
            ),
            (
                Some("application/json"),
                "{}".into(),
                StatusCode::BAD_REQUEST,
                "invalid input",
            ),
            (
                Some("application/json"),
                wrong_type.to_string(),
                StatusCode::BAD_REQUEST,
                "invalid input",
            ),
            (
                Some("application/json"),
                unknown_field.to_string(),
                StatusCode::BAD_REQUEST,
                "invalid input",
            ),
            (
                None,
                valid_input.to_string(),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "expected application/json",
            ),
            (
                Some("text/plain"),
                valid_input.to_string(),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "expected application/json",
            ),
            (
                Some("application/json"),
                oversized.to_string(),
                StatusCode::PAYLOAD_TOO_LARGE,
                "request body too large",
            ),
        ] {
            let mut request = Request::post(path).extension(axum::extract::ConnectInfo(
                "192.0.2.1:1234".parse::<std::net::SocketAddr>().unwrap(),
            ));
            if let Some(content_type) = content_type {
                request = request.header(header::CONTENT_TYPE, content_type);
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::from(input)).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), status, "{path}: {error}");
            assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert!(!response.headers().contains_key(header::SET_COOKIE));
            assert_eq!(body(response).await, json!({"error": error}));
        }
    }
}

#[sqlx::test]
async fn setup_token_is_required_and_does_not_reveal_bootstrap_state(pool: PgPool) {
    let setup_token = "setup-token-test-only";
    let app = app(AppState {
        pool: pool.clone(),
        cookie_secure: true,
        setup_token: Some(setup_token.into()),
        sign_in_throttle: Default::default(),
        message_delivery: Default::default(),
        session_changes: Default::default(),
        session_cleanup: Default::default(),
        ws_allowed_origins: Default::default(),
    });
    let expected = json!({"error": "invalid credentials"});
    for completed in [false, true] {
        for token in [
            None,
            Some(Value::Null),
            Some(json!("")),
            Some(json!("wrong-token-test-only")),
            Some(json!("setup-token-test-onlY")),
            Some(json!("setup-token-test-only-longer")),
            Some(json!("setup-token-test-only\u{200b}")),
        ] {
            let mut input = setup_input();
            if let Some(token) = token {
                input["setup_token"] = token;
            }
            let response = request(&app, "POST", "/api/v1/setup", input, &[]).await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(body(response).await, expected);
        }
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM organizations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, i64::from(completed));
        let mut input = setup_input();
        input["setup_token"] = json!(setup_token);
        let response = request(&app, "POST", "/api/v1/setup", input, &[]).await;
        assert_eq!(
            response.status(),
            if completed {
                StatusCode::CONFLICT
            } else {
                StatusCode::CREATED
            }
        );
    }
}

#[sqlx::test]
async fn setup_with_unconfigured_token_ignores_supplied_token(pool: PgPool) {
    let app = router(&pool);
    let mut input = setup_input();
    input["setup_token"] = json!("client-supplied-test-only");
    assert_eq!(
        request(&app, "POST", "/api/v1/setup", input, &[])
            .await
            .status(),
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn setup_token_precedes_semantic_validation_and_database_access() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let app = app(AppState {
        pool,
        cookie_secure: true,
        setup_token: Some("setup-token-test-only".into()),
        sign_in_throttle: Default::default(),
        message_delivery: Default::default(),
        session_changes: Default::default(),
        session_cleanup: Default::default(),
        ws_allowed_origins: Default::default(),
    });
    for token in [None, Some(""), Some("wrong-token-test-only")] {
        let mut input = setup_input();
        input["email"] = json!("invalid");
        input["password"] = json!("short");
        if let Some(token) = token {
            input["setup_token"] = json!(token);
        }
        let response = request(&app, "POST", "/api/v1/setup", input, &[]).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            body(response).await,
            json!({"error": "invalid credentials"})
        );
    }
}

#[sqlx::test]
async fn sign_in_without_organization_uses_the_only_organization(pool: PgPool) {
    let app = router(&pool);
    let identity = setup(&app).await;
    let organization_id = identity["organization"]["organization_id"]
        .as_str()
        .unwrap();
    let input = json!({"email": "Owner@Example.com", "password": PASSWORD});
    let response = request(&app, "POST", "/api/v1/session", input.clone(), &[]).await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let session = body(response).await;
    assert_eq!(session["identity"], identity);
    let token = session["token"].as_str().unwrap();
    assert!(token.starts_with(&format!("{organization_id}.")));
    let bearer = format!("Bearer {token}");
    for headers in [[("cookie", cookie.as_str())], [("authorization", &bearer)]] {
        let response = request(&app, "GET", "/api/v1/me", Value::Null, &headers).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body(response).await, identity);
    }
    let mut null_organization = input.clone();
    null_organization["organization_id"] = Value::Null;
    assert_eq!(
        request(&app, "POST", "/api/v1/session", null_organization, &[])
            .await
            .status(),
        StatusCode::OK
    );
    for (field, value) in [
        ("email", "unknown@example.com".to_owned()),
        ("password", "incorrect password".to_owned()),
        ("organization_id", Uuid::new_v4().to_string()),
    ] {
        let mut invalid = input.clone();
        invalid[field] = json!(value);
        let response = request(&app, "POST", "/api/v1/session", invalid, &[]).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            body(response).await,
            json!({"error": "invalid credentials"})
        );
    }
}

#[sqlx::test]
async fn sign_in_without_organization_rejects_multiple_organizations(pool: PgPool) {
    let app = router(&pool);
    let (_, second_id) = two_organizations(&pool, &app).await;
    let mut input = json!({"email": "owner@example.com", "password": PASSWORD});
    for explicit_null in [false, true] {
        if explicit_null {
            input["organization_id"] = Value::Null;
        }
        let response = request(&app, "POST", "/api/v1/session", input.clone(), &[]).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body(response).await, json!({"error": "invalid input"}));
    }
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(sessions, 0);
    assert_eq!(
        sign_in(&app, &second_id.to_string(), PASSWORD)
            .await
            .status(),
        StatusCode::OK
    );
}

#[sqlx::test]
async fn sign_in_without_organization_rejects_an_unconfigured_instance(pool: PgPool) {
    let response = request(
        &router(&pool),
        "POST",
        "/api/v1/session",
        json!({"email": "owner@example.com", "password": PASSWORD}),
        &[],
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[sqlx::test]
async fn sign_in_cookie_bearer_and_sign_out(pool: PgPool) {
    let app = router(&pool);
    let identity = setup(&app).await;
    let organization_id = identity["organization"]["organization_id"]
        .as_str()
        .unwrap();
    assert_eq!(
        sign_in(&app, organization_id, "incorrect password")
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let unknown = request(&app, "POST", "/api/v1/session", json!({"organization_id": organization_id, "email": "unknown@example.com", "password": PASSWORD}), &[]).await;
    assert_eq!(unknown.status(), StatusCode::UNAUTHORIZED);
    let response = sign_in(&app, organization_id, PASSWORD).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .to_owned();
    for flag in [
        "HttpOnly",
        "Secure",
        "SameSite=Strict",
        "Path=/",
        "Max-Age=2592000",
    ] {
        assert!(cookie.contains(flag));
    }
    let cookie = cookie.split(';').next().unwrap();
    let session = body(response).await;
    let token = session["token"].as_str().unwrap();
    let bearer = format!("Bearer {token}");
    for headers in [[("cookie", cookie)], [("authorization", bearer.as_str())]] {
        let response = request(&app, "GET", "/api/v1/me", Value::Null, &headers).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(body(response).await, identity);
    }
    // Raw credentials must never be persisted.
    let hashes: Vec<Vec<u8>> =
        sqlx::query_scalar("SELECT token_hash FROM sessions WHERE organization_id = $1")
            .bind(organization_id.parse::<Uuid>().unwrap())
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(hashes.len(), 1);
    assert_eq!(hashes[0].len(), 32);
    assert_ne!(hashes[0], token.as_bytes());
    let other = body(sign_in(&app, organization_id, PASSWORD).await).await;
    let other_bearer = format!("Bearer {}", other["token"].as_str().unwrap());
    let response = request(
        &app,
        "DELETE",
        "/api/v1/session",
        Value::Null,
        &[("cookie", cookie)],
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(
        response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("Max-Age=0")
    );
    for headers in [[("cookie", cookie)], [("authorization", bearer.as_str())]] {
        assert_eq!(
            request(&app, "GET", "/api/v1/me", Value::Null, &headers)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/v1/me",
            Value::Null,
            &[("authorization", &other_bearer)]
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            "DELETE",
            "/api/v1/session",
            Value::Null,
            &[("authorization", &other_bearer)]
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/v1/me",
            Value::Null,
            &[("authorization", &other_bearer)]
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test]
async fn invalid_expired_and_ambiguous_credentials_are_refused(pool: PgPool) {
    let app = router(&pool);
    let identity = setup(&app).await;
    let id = identity["organization"]["organization_id"]
        .as_str()
        .unwrap();
    let session = body(sign_in(&app, id, PASSWORD).await).await;
    let token = session["token"].as_str().unwrap();
    let cookie = format!("fukulow_session={token}");
    let bearer = format!("Bearer {token}");
    let duplicate_cookie = format!("{cookie}; {cookie}");
    let forged = format!("Bearer {id}.{}", "0".repeat(64));
    for headers in [
        vec![],
        vec![("authorization", "Bearer garbage")],
        vec![("authorization", forged.as_str())],
        vec![("cookie", duplicate_cookie.as_str())],
        vec![
            ("authorization", "Basic invalid"),
            ("cookie", cookie.as_str()),
        ],
        vec![
            ("authorization", bearer.as_str()),
            ("authorization", bearer.as_str()),
        ],
    ] {
        assert_eq!(
            request(&app, "GET", "/api/v1/me", Value::Null, &headers)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    sqlx::query(
        "UPDATE sessions SET expires_at = now() - interval '1 second' WHERE organization_id = $1",
    )
    .bind(id.parse::<Uuid>().unwrap())
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/v1/me",
            Value::Null,
            &[("authorization", &bearer)]
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/v1/me",
            Value::Null,
            &[("cookie", &cookie)]
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test]
async fn session_cannot_access_another_organization(pool: PgPool) {
    let app = router(&pool);
    let (first, second_id) = two_organizations(&pool, &app).await;
    let first_id = first["organization"]["organization_id"].as_str().unwrap();
    let session = body(sign_in(&app, first_id, PASSWORD).await).await;
    let token = session["token"].as_str().unwrap();
    let bearer = format!("Bearer {token}");
    let response = request(
        &app,
        "GET",
        &format!("/api/v1/me?organization_id={second_id}"),
        Value::Null,
        &[
            ("authorization", &bearer),
            ("x-organization-id", &second_id.to_string()),
        ],
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await, first);
    let swapped = format!("{}.{}", second_id, token.split_once('.').unwrap().1);
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/v1/me",
            Value::Null,
            &[("authorization", &format!("Bearer {swapped}"))]
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/v1/me",
            Value::Null,
            &[("cookie", &format!("fukulow_session={swapped}"))]
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        sign_in(&app, &Uuid::new_v4().to_string(), PASSWORD)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let second = body(sign_in(&app, &second_id.to_string(), PASSWORD).await).await;
    assert_eq!(
        second["identity"]["organization"]["organization_id"],
        second_id.to_string()
    );
    assert_eq!(second["identity"]["member"]["name"], "Owner B");
    assert_eq!(second["identity"]["member"]["role"], "guest");
    // A composite FK must reject a member id belonging only to another tenant.
    let first_only = Uuid::new_v4();
    sqlx::query("INSERT INTO users (organization_id, id, email, name, password_hash, role) SELECT organization_id, $2, 'only-a@example.com', name, password_hash, role FROM users WHERE organization_id = $1")
        .bind(first_id.parse::<Uuid>().unwrap()).bind(first_only).execute(&pool).await.unwrap();
    assert!(
        sqlx::query(
            "INSERT INTO sessions (organization_id, token_hash, user_id) VALUES ($1, $2, $3)"
        )
        .bind(second_id)
        .bind(vec![0u8; 32])
        .bind(first_only)
        .execute(&pool)
        .await
        .is_err()
    );
}

#[sqlx::test]
async fn invalid_setup_does_not_consume_bootstrap(pool: PgPool) {
    let app = router(&pool);
    for (field, value) in [
        ("password", "short"),
        ("email", "invalid"),
        ("organization_name", "  "),
        ("name", ""),
    ] {
        let mut input = setup_input();
        input[field] = json!(value);
        assert_eq!(
            request(&app, "POST", "/api/v1/setup", input, &[])
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    setup(&app).await;
}

async fn sign_in_from(
    app: &Router,
    peer: &str,
    organization_id: Option<Uuid>,
    email: &str,
    password: &str,
    forwarded: Option<&str>,
) -> Response {
    let mut request = Request::post("/api/v1/session")
        .extension(axum::extract::ConnectInfo(
            peer.parse::<std::net::SocketAddr>().unwrap(),
        ))
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(forwarded) = forwarded {
        request = request.header("x-forwarded-for", forwarded);
    }
    app.clone()
        .oneshot(
            request
                .body(Body::from(
                    json!({
                        "organization_id": organization_id, "email": email, "password": password
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn assert_throttled(response: Response) {
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    assert!(
        (1..=60).contains(
            &response.headers()[header::RETRY_AFTER]
                .to_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
        )
    );
    assert_eq!(
        body(response).await,
        json!({"error": "too many sign-in attempts"})
    );
}

#[sqlx::test]
async fn failed_sign_ins_throttle_account_across_ips_but_not_other_accounts_or_organizations(
    pool: PgPool,
) {
    let app = router(&pool);
    let (first, second) = two_organizations(&pool, &app).await;
    let first: Uuid = first["organization"]["organization_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    sqlx::query("INSERT INTO users (organization_id, id, email, name, password_hash, role) SELECT organization_id, $2, 'other@example.com', name, password_hash, role FROM users WHERE organization_id = $1")
        .bind(first).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    for n in 1..=5 {
        let response = sign_in_from(
            &app,
            &format!("192.0.2.{n}:1234"),
            Some(first),
            " Owner@Example.com ",
            "incorrect password",
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    // Another IP cannot bypass the account budget, even with the correct password.
    assert_throttled(
        sign_in_from(
            &app,
            "192.0.2.6:1234",
            Some(first),
            "owner@example.com",
            PASSWORD,
            None,
        )
        .await,
    )
    .await;
    // A different account on the same IP and the same email in another tenant work.
    for (organization, email) in [(first, "other@example.com"), (second, "owner@example.com")] {
        assert_eq!(
            sign_in_from(
                &app,
                "192.0.2.1:1234",
                Some(organization),
                email,
                PASSWORD,
                None
            )
            .await
            .status(),
            StatusCode::OK
        );
    }
    // Advance only between DB operations; SQLx needs a running clock for network I/O.
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(61)).await;
    tokio::time::resume();
    assert_eq!(
        sign_in_from(
            &app,
            "192.0.2.1:1234",
            Some(first),
            "owner@example.com",
            PASSWORD,
            None
        )
        .await
        .status(),
        StatusCode::OK
    );
}

#[sqlx::test]
async fn failed_sign_ins_throttle_ip_and_ignore_spoofed_forwarded_header_by_default(pool: PgPool) {
    let app = router(&pool);
    let first = setup(&app).await;
    let organization: Uuid = first["organization"]["organization_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    for n in 1..=20 {
        // Unknown accounts count too; changing an untrusted header cannot split the IP budget.
        let response = sign_in_from(
            &app,
            "192.0.2.1:1234",
            Some(organization),
            &format!("unknown{n}@example.com"),
            "incorrect password",
            Some(&format!("198.51.100.{n}")),
        )
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    assert_throttled(
        sign_in_from(
            &app,
            "192.0.2.1:1234",
            None,
            "owner@example.com",
            PASSWORD,
            Some("203.0.113.99"),
        )
        .await,
    )
    .await;
    assert_eq!(
        sign_in_from(
            &app,
            "192.0.2.2:1234",
            Some(organization),
            "owner@example.com",
            PASSWORD,
            Some("203.0.113.99")
        )
        .await
        .status(),
        StatusCode::OK
    );
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(61)).await;
    tokio::time::resume();
    assert_eq!(
        sign_in_from(
            &app,
            "192.0.2.1:1234",
            None,
            "owner@example.com",
            PASSWORD,
            None
        )
        .await
        .status(),
        StatusCode::OK
    );
}

#[sqlx::test]
async fn trusted_proxy_uses_rightmost_client_ip_and_omitted_organization_shares_account_budget(
    pool: PgPool,
) {
    let app = app(AppState {
        pool: pool.clone(),
        cookie_secure: true,
        setup_token: None,
        sign_in_throttle: fukulow_server::auth::SignInThrottle::with_proxy_config(
            Some("192.0.2.1"),
            Some("x-forwarded-for"),
        )
        .unwrap(),
        message_delivery: Default::default(),
        session_changes: Default::default(),
        session_cleanup: Default::default(),
        ws_allowed_origins: Default::default(),
    });
    let first = setup(&app).await;
    let organization: Uuid = first["organization"]["organization_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    for n in 1..=20 {
        assert_eq!(
            sign_in_from(
                &app,
                "192.0.2.1:1234",
                Some(organization),
                &format!("unknown{n}@example.com"),
                "incorrect password",
                Some("spoofed, 198.51.100.1")
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_throttled(
        sign_in_from(
            &app,
            "192.0.2.1:1234",
            None,
            "owner@example.com",
            PASSWORD,
            Some("198.51.100.99, 198.51.100.1"),
        )
        .await,
    )
    .await;
    // The second real client behind the same proxy remains unaffected.
    for _ in 0..6 {
        assert_eq!(
            sign_in_from(
                &app,
                "192.0.2.1:1234",
                None,
                "owner@example.com",
                PASSWORD,
                Some("198.51.100.2")
            )
            .await
            .status(),
            StatusCode::OK
        );
    }
    for n in 1..=5 {
        assert_eq!(
            sign_in_from(
                &app,
                "192.0.2.1:1234",
                if n % 2 == 0 { Some(organization) } else { None },
                " Owner@Example.com ",
                "incorrect password",
                Some("198.51.100.2")
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_throttled(
        sign_in_from(
            &app,
            "192.0.2.1:1234",
            Some(organization),
            "owner@example.com",
            PASSWORD,
            Some("198.51.100.3"),
        )
        .await,
    )
    .await;
}

async fn advance_cleanup_interval_and_expire_throttle_window() {
    // Pause only between SQL operations; network I/O needs a running clock.
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(61)).await;
    tokio::time::resume();
}

#[sqlx::test]
async fn ambiguous_organization_charges_only_ip_budget_and_leaves_other_sign_ins_usable(
    pool: PgPool,
) {
    let app = router(&pool);
    let (first, second) = two_organizations(&pool, &app).await;
    let first: Uuid = first["organization"]["organization_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    for n in 1..=20 {
        let response = sign_in_from(
            &app,
            "192.0.2.1:1234",
            None,
            "owner@example.com",
            PASSWORD,
            None,
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body(response).await, json!({"error": "invalid input"}));
        if n == 10 {
            // More than the account limit of ambiguous failures did not charge either account.
            for organization in [first, second] {
                assert_eq!(
                    sign_in_from(
                        &app,
                        "192.0.2.1:1234",
                        Some(organization),
                        "owner@example.com",
                        PASSWORD,
                        None
                    )
                    .await
                    .status(),
                    StatusCode::OK
                );
            }
        }
    }
    for organization in [None, Some(first), Some(second)] {
        assert_throttled(
            sign_in_from(
                &app,
                "192.0.2.1:1234",
                organization,
                "owner@example.com",
                PASSWORD,
                None,
            )
            .await,
        )
        .await;
    }
    for organization in [first, second] {
        assert_eq!(
            sign_in_from(
                &app,
                "192.0.2.2:1234",
                Some(organization),
                "owner@example.com",
                PASSWORD,
                None
            )
            .await
            .status(),
            StatusCode::OK
        );
    }
    advance_cleanup_interval_and_expire_throttle_window().await;
    // Existing credential failures and ambiguous lookups consume the same IP budget.
    for _ in 0..19 {
        assert_eq!(
            sign_in_from(
                &app,
                "192.0.2.1:1234",
                None,
                "owner@example.com",
                PASSWORD,
                None
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        sign_in_from(
            &app,
            "192.0.2.1:1234",
            Some(first),
            "owner@example.com",
            "incorrect password",
            None
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_throttled(
        sign_in_from(
            &app,
            "192.0.2.1:1234",
            Some(first),
            "owner@example.com",
            PASSWORD,
            None,
        )
        .await,
    )
    .await;
}
