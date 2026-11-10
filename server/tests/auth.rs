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
        shutdown: Default::default(),
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

async fn sign_in(app: &Router, _organization_id: &str, password: &str) -> Response {
    request(
        app,
        "POST",
        "/api/v1/session",
        json!({"email": "owner@example.com", "password": password}),
        &[],
    )
    .await
}

async fn assert_internal_error(response: Response) {
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    // Exact equality excludes SQL, table/column names, credentials and worker details.
    assert_eq!(body(response).await, json!({"error": "internal error"}));
}

#[sqlx::test]
async fn auth_extractor_database_failures_return_generic_500_on_all_protected_endpoints(
    pool: PgPool,
) {
    let app = router(&pool);
    let identity = setup(&app).await;
    let session = body(
        sign_in(
            &app,
            identity["organization"]["organization_id"]
                .as_str()
                .unwrap(),
            PASSWORD,
        )
        .await,
    )
    .await;
    let authorization = format!("Bearer {}", session["token"].as_str().unwrap());
    let headers = [
        ("authorization", authorization.as_str()),
        ("host", "chat.example"),
        ("origin", "https://chat.example"),
    ];
    assert_eq!(
        request(&app, "GET", "/api/v1/me", Value::Null, &headers)
            .await
            .status(),
        StatusCode::OK
    );
    // Break identity resolution after establishing a valid session, without changing handlers.
    sqlx::query(
        "ALTER TABLE account_sessions RENAME COLUMN account_id TO injected_unavailable_account",
    )
    .execute(&pool)
    .await
    .unwrap();
    let org = identity["organization"]["organization_id"]
        .as_str()
        .unwrap();
    let channels = format!("/api/v1/orgs/{org}/channels");
    let ws = format!("/api/v1/orgs/{org}/ws");
    let messages = format!("/api/v1/orgs/{org}/channels/{}/messages", Uuid::new_v4());
    for (method, path, input) in [
        ("GET", "/api/v1/me", Value::Null),
        ("DELETE", "/api/v1/session", Value::Null),
        ("GET", channels.as_str(), Value::Null),
        (
            "POST",
            channels.as_str(),
            json!({"name": "Channel", "visibility": "public"}),
        ),
        ("GET", messages.as_str(), Value::Null),
        (
            "POST",
            messages.as_str(),
            json!({"client_message_id": Uuid::new_v4(), "body": "Message"}),
        ),
        ("GET", ws.as_str(), Value::Null),
    ] {
        assert_internal_error(request(&app, method, path, input, &headers).await).await;
    }
    assert_eq!(
        request(&app, "GET", "/api/v1/me", Value::Null, &[])
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test]
async fn public_endpoint_database_failures_return_generic_500(pool: PgPool) {
    let app = router(&pool);
    sqlx::raw_sql("ALTER TABLE accounts RENAME TO injected_unavailable_accounts; ALTER TABLE organizations RENAME TO injected_unavailable_organizations;")
        .execute(&pool)
        .await
        .unwrap();
    for (method, path, input) in [
        ("GET", "/api/v1/setup", Value::Null),
        ("POST", "/api/v1/setup", setup_input()),
        (
            "POST",
            "/api/v1/session",
            json!({"email": "owner@example.com", "password": PASSWORD}),
        ),
    ] {
        assert_internal_error(request(&app, method, path, input, &[]).await).await;
    }
}

#[sqlx::test]
async fn sign_out_database_failure_returns_generic_500_and_preserves_session(pool: PgPool) {
    let app = router(&pool);
    let identity = setup(&app).await;
    let session = body(
        sign_in(
            &app,
            identity["organization"]["organization_id"]
                .as_str()
                .unwrap(),
            PASSWORD,
        )
        .await,
    )
    .await;
    let authorization = format!("Bearer {}", session["token"].as_str().unwrap());
    let headers = [("authorization", authorization.as_str())];
    sqlx::raw_sql("CREATE FUNCTION fail_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected session deletion failure'; END $$; CREATE TRIGGER fail_session_delete BEFORE DELETE ON account_sessions FOR EACH ROW EXECUTE FUNCTION fail_session_delete();")
        .execute(&pool).await.unwrap();
    assert_internal_error(request(&app, "DELETE", "/api/v1/session", Value::Null, &headers).await)
        .await;
    assert_eq!(
        request(&app, "GET", "/api/v1/me", Value::Null, &headers)
            .await
            .status(),
        StatusCode::OK
    );
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
    sqlx::query("INSERT INTO users (organization_id, id, account_id, name, role) SELECT $1, id, account_id, 'Owner B', 'guest' FROM users WHERE organization_id = $2")
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
            shutdown: Default::default(),
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
        "SELECT (SELECT count(*) FROM organizations), (SELECT count(*) FROM users), (SELECT count(*) FROM account_sessions)",
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
        "SELECT (SELECT count(*) FROM organizations), (SELECT count(*) FROM users), (SELECT count(*) FROM account_sessions)",
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
        "SELECT count(*) OVER (), a.password_hash, u.role FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.organization_id = $1",
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
            shutdown: Default::default(),
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
        shutdown: Default::default(),
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
        shutdown: Default::default(),
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
    let response = request(
        &app,
        "POST",
        "/api/v1/session",
        json!({"email":"Owner@Example.com","password":PASSWORD}),
        &[],
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let session = body(response).await;
    assert_eq!(session["identity"]["account"]["email"], "owner@example.com");
    assert_eq!(
        session["identity"]["organizations"],
        json!([identity["organization"]])
    );
    let bearer = format!("Bearer {}", session["token"].as_str().unwrap());
    for headers in [
        [("cookie", cookie.as_str())],
        [("authorization", bearer.as_str())],
    ] {
        let response = request(&app, "GET", "/api/v1/me", Value::Null, &headers).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body(response).await, session["identity"]);
    }
    for invalid in [
        json!({"email":"unknown@example.com","password":PASSWORD}),
        json!({"email":"owner@example.com","password":"incorrect password"}),
    ] {
        let response = request(&app, "POST", "/api/v1/session", invalid, &[]).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body(response).await, json!({"error":"invalid credentials"}));
    }
    let response = request(
        &app,
        "POST",
        "/api/v1/session",
        json!({"organization_id":null,"email":"owner@example.com","password":PASSWORD}),
        &[],
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[sqlx::test]
async fn one_account_has_independent_members_and_roles_in_multiple_organizations(pool: PgPool) {
    let app = router(&pool);
    let (first, second) = two_organizations(&pool, &app).await;
    let response = sign_in(&app, "", PASSWORD).await;
    assert_eq!(response.status(), StatusCode::OK);
    let session = body(response).await;
    assert_eq!(
        session["identity"]["organizations"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let auth = format!("Bearer {}", session["token"].as_str().unwrap());
    for (organization, name, role) in [
        (
            first["organization"]["organization_id"]
                .as_str()
                .unwrap()
                .parse::<Uuid>()
                .unwrap(),
            "Owner A",
            "owner",
        ),
        (second, "Owner B", "guest"),
    ] {
        let response = request(
            &app,
            "GET",
            &format!("/api/v1/orgs/{organization}/me"),
            Value::Null,
            &[("authorization", &auth)],
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let identity = body(response).await;
        assert_eq!(identity["member"]["name"], name);
        assert_eq!(identity["member"]["role"], role);
        assert!(identity["member"].get("email").is_none());
    }
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
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
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
    let unknown = request(
        &app,
        "POST",
        "/api/v1/session",
        json!({"email": "unknown@example.com", "password": PASSWORD}),
        &[],
    )
    .await;
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
        assert_eq!(body(response).await, session["identity"]);
    }
    // Raw credentials must never be persisted.
    let hashes: Vec<Vec<u8>> =
        sqlx::query_scalar("SELECT token_hash FROM account_sessions WHERE account_id IN (SELECT account_id FROM users WHERE organization_id = $1)")
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
async fn offline_restore_ends_every_account_session_and_preserves_members(pool: PgPool) {
    let app = router(&pool);
    let (_, second) = two_organizations(&pool, &app).await;
    sqlx::query("INSERT INTO accounts (id, email, password_hash) SELECT gen_random_uuid(), 'second@example.com', password_hash FROM accounts LIMIT 1")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO users (organization_id, id, account_id, name, role) SELECT $1, gen_random_uuid(), id, 'Second', 'member' FROM accounts WHERE email = 'second@example.com'")
        .bind(second).execute(&pool).await.unwrap();
    let members: String = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(u) ORDER BY organization_id, id)::text FROM users u",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let mut credentials = Vec::new();
    for email in [
        "owner@example.com",
        "owner@example.com",
        "second@example.com",
    ] {
        let response = request(
            &app,
            "POST",
            "/api/v1/session",
            json!({"email": email, "password": PASSWORD}),
            &[],
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let session = body(response).await;
        credentials.push((
            cookie,
            format!("Bearer {}", session["token"].as_str().unwrap()),
        ));
    }
    for (cookie, bearer) in &credentials {
        for headers in [
            [("cookie", cookie.as_str())],
            [("authorization", bearer.as_str())],
        ] {
            assert_eq!(
                request(&app, "GET", "/api/v1/me", Value::Null, &headers)
                    .await
                    .status(),
                StatusCode::OK
            );
        }
    }
    sqlx::raw_sql(include_str!("../src/auth/end-all-sessions.sql"))
        .execute(&pool)
        .await
        .unwrap();
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM account_sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0);
    for (cookie, bearer) in &credentials {
        for headers in [
            [("cookie", cookie.as_str())],
            [("authorization", bearer.as_str())],
        ] {
            assert_eq!(
                request(&app, "GET", "/api/v1/me", Value::Null, &headers)
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
    }
    let after: String = sqlx::query_scalar(
        "SELECT jsonb_agg(to_jsonb(u) ORDER BY organization_id, id)::text FROM users u",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(members, after);
    assert_eq!(sign_in(&app, "", PASSWORD).await.status(), StatusCode::OK);
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
        "UPDATE account_sessions SET expires_at = now() - interval '1 second' WHERE account_id IN (SELECT account_id FROM users WHERE organization_id = $1)",
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
    let first = setup(&app).await;
    let first_id = first["organization"]["organization_id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let foreign = Uuid::new_v4();
    let account = Uuid::new_v4();
    let shared_id = first["member"]["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    sqlx::query("INSERT INTO organizations (organization_id,name) VALUES ($1,'Foreign')")
        .bind(foreign)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO accounts (id,email,password_hash) VALUES ($1,'foreign@example.com','unused')",
    )
    .bind(account)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO users (organization_id,id,account_id,name,role) VALUES ($1,$2,$3,'Foreign member','owner')").bind(foreign).bind(shared_id).bind(account).execute(&pool).await.unwrap();
    let session = body(sign_in(&app, "", PASSWORD).await).await;
    let auth = format!("Bearer {}", session["token"].as_str().unwrap());
    let mut refusal = None;
    for organization in [foreign, Uuid::new_v4(), first_id] {
        if organization == first_id {
            sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1")
                .bind(first_id)
                .execute(&pool)
                .await
                .unwrap();
        }
        for suffix in ["me", "channels", "ws"] {
            let response = request(
                &app,
                "GET",
                &format!("/api/v1/orgs/{organization}/{suffix}"),
                Value::Null,
                &[("authorization", &auth)],
            )
            .await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            let error = body(response).await;
            assert_eq!(error["error"], "organization_unavailable");
            if let Some(expected) = &refusal {
                assert_eq!(&error, expected);
            } else {
                refusal = Some(error);
            }
        }
    }
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/v1/me",
            Value::Null,
            &[("authorization", &auth)]
        )
        .await
        .status(),
        StatusCode::OK
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
    _organization_id: Option<Uuid>,
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
                        "email": email, "password": password
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
async fn failed_sign_ins_throttle_account_across_ips_but_not_other_accounts(pool: PgPool) {
    let app = router(&pool);
    setup(&app).await;
    sqlx::query("INSERT INTO accounts (id,email,password_hash) SELECT $1,'other@example.com',password_hash FROM accounts").bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    for n in 1..=5 {
        assert_eq!(
            sign_in_from(
                &app,
                &format!("192.0.2.{n}:1234"),
                None,
                " Owner@Example.com ",
                "incorrect password",
                None
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_throttled(
        sign_in_from(
            &app,
            "192.0.2.6:1234",
            None,
            "owner@example.com",
            PASSWORD,
            None,
        )
        .await,
    )
    .await;
    assert_eq!(
        sign_in_from(
            &app,
            "192.0.2.1:1234",
            None,
            "other@example.com",
            PASSWORD,
            None
        )
        .await
        .status(),
        StatusCode::OK
    );
    advance_cleanup_interval_and_expire_throttle_window().await;
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
        shutdown: Default::default(),
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
async fn multiple_organizations_do_not_make_account_sign_in_ambiguous(pool: PgPool) {
    let app = router(&pool);
    two_organizations(&pool, &app).await;
    for _ in 0..6 {
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
}

// Generated once with argon2 0.5.3 defaults and the 16-byte salt
// b"0123456789abcdef"; do not regenerate with the dependency under test.
const ARGON2_053_PHC: &str = "$argon2id$v=19$m=19456,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$gy5SuVm5Z7Vw7keB9se9p87QGcomaseB/S2U1OhTsM0";

#[sqlx::test]
async fn argon2_053_fixture_signs_in_and_rejects_wrong_password(pool: PgPool) {
    let app = router(&pool);
    let identity = setup(&app).await;
    let organization = identity["organization"]["organization_id"]
        .as_str()
        .unwrap();
    sqlx::query("UPDATE accounts SET password_hash = $1 WHERE id IN (SELECT account_id FROM users WHERE organization_id = $2)")
        .bind(ARGON2_053_PHC)
        .bind(organization.parse::<Uuid>().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        sign_in(&app, organization, PASSWORD).await.status(),
        StatusCode::OK
    );
    let response = sign_in(&app, organization, "incorrect password").await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        body(response).await,
        json!({"error": "invalid credentials"})
    );
}

#[sqlx::test]
async fn new_password_hash_preserves_explicit_parameters_and_salt_length(pool: PgPool) {
    let identity = setup(&router(&pool)).await;
    let hash: String =
        sqlx::query_scalar("SELECT password_hash FROM accounts WHERE id IN (SELECT account_id FROM users WHERE organization_id = $1)")
            .bind(
                identity["organization"]["organization_id"]
                    .as_str()
                    .unwrap()
                    .parse::<Uuid>()
                    .unwrap(),
            )
            .fetch_one(&pool)
            .await
            .unwrap();
    let fields: Vec<_> = hash.split('$').collect();
    assert_eq!(fields.len(), 6);
    assert_eq!(&fields[..4], &["", "argon2id", "v=19", "m=19456,t=2,p=1"]);
    // PHC uses unpadded base64: 16 salt bytes -> 22 chars; 32 output bytes -> 43.
    assert_eq!(fields[4].len(), 22);
    assert_eq!(fields[5].len(), 43);
    assert!(fields[4..].iter().all(|field| {
        field
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
    }));
}

// Independent SHA-256 fixture computed with Node's crypto module, not sha2.
const FIXED_CREDENTIAL: &str = "11111111-2222-4333-8444-555555555555.000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const FIXED_DIGEST: &str = "da36cd522069db7890f63fe6e69904762a6868b9b26b8533b81792b4eda34db0";

#[sqlx::test]
async fn fixed_session_fixture_authenticates_by_cookie_and_bearer(pool: PgPool) {
    let organization: Uuid = "11111111-2222-4333-8444-555555555555".parse().unwrap();
    let account = Uuid::new_v4();
    let user_id = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (organization_id,name) VALUES ($1,'Fixture')")
        .bind(organization)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO accounts (id,email,password_hash) VALUES ($1,'fixture@example.com',$2)",
    )
    .bind(account)
    .bind(ARGON2_053_PHC)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO users (organization_id,id,account_id,name,role) VALUES ($1,$2,$3,'Fixture','owner')").bind(organization).bind(user_id).bind(account).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO account_sessions (account_id,token_hash) VALUES ($1,decode($2,'hex'))",
    )
    .bind(account)
    .bind(FIXED_DIGEST)
    .execute(&pool)
    .await
    .unwrap();
    let app = router(&pool);
    for (name, value) in [
        ("cookie", format!("fukulow_session={FIXED_CREDENTIAL}")),
        ("authorization", format!("Bearer {FIXED_CREDENTIAL}")),
    ] {
        let response = request(&app, "GET", "/api/v1/me", Value::Null, &[(name, &value)]).await;
        assert_eq!(response.status(), StatusCode::OK);
        let identity = body(response).await;
        assert_eq!(identity["account"]["id"], account.to_string());
        assert_eq!(
            identity["organizations"][0]["organization_id"],
            organization.to_string()
        );
    }
}

#[sqlx::test]
async fn issued_session_uses_32_random_bytes_and_hashes_full_credential(pool: PgPool) {
    let app = router(&pool);
    let identity = setup(&app).await;
    let organization = identity["organization"]["organization_id"]
        .as_str()
        .unwrap();
    let mut tokens = Vec::new();
    for _ in 0..2 {
        let response = sign_in(&app, organization, PASSWORD).await;
        assert_eq!(response.status(), StatusCode::OK);
        let session = body(response).await;
        let token = session["token"].as_str().unwrap();
        let secret = token;
        assert_eq!(secret.len(), 64);
        assert!(
            secret
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
        // PostgreSQL's SHA-256 is independent from the Rust implementation.
        let stored: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM account_sessions WHERE account_id IN (SELECT account_id FROM users WHERE organization_id = $1) AND token_hash = sha256(convert_to($2, 'UTF8')))")
            .bind(organization.parse::<Uuid>().unwrap()).bind(token).fetch_one(&pool).await.unwrap();
        assert!(stored);
        tokens.push(token.to_owned());
    }
    assert_ne!(tokens[0], tokens[1]);
}

#[sqlx::test]
async fn duplicate_membership_is_rejected_and_member_identity_is_preserved(pool: PgPool) {
    let app = router(&pool);
    let identity = setup(&app).await;
    let organization: Uuid = identity["organization"]["organization_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let account: Uuid = sqlx::query_scalar("SELECT account_id FROM users WHERE organization_id=$1")
        .bind(organization)
        .fetch_one(&pool)
        .await
        .unwrap();
    let error=sqlx::query("INSERT INTO users (organization_id,id,account_id,name,role) VALUES ($1,$2,$3,'Duplicate','guest')").bind(organization).bind(Uuid::new_v4()).bind(account).execute(&pool).await.unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23505")
    );
    assert!(
        sqlx::query("DELETE FROM users WHERE organization_id=$1")
            .bind(organization)
            .execute(&pool)
            .await
            .is_err()
    );
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1")
        .bind(organization)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1")
        .bind(organization)
        .execute(&pool)
        .await
        .unwrap();
    let (member, revision): (Uuid, i64) =
        sqlx::query_as("SELECT id,membership_revision FROM users WHERE organization_id=$1")
            .bind(organization)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(member.to_string(), identity["member"]["id"]);
    assert_eq!(revision, 1);
}

#[sqlx::test]
async fn member_truncate_is_refused_and_preserves_history(pool: PgPool) {
    let app = router(&pool);
    let identity = setup(&app).await;
    let error = sqlx::query("TRUNCATE users CASCADE")
        .execute(&pool)
        .await
        .unwrap_err();
    assert!(
        error
            .as_database_error()
            .unwrap()
            .message()
            .contains("Member rows must never be truncated")
    );
    let member: Uuid = sqlx::query_scalar("SELECT id FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(member.to_string(), identity["member"]["id"]);
}
