use super::*;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::FromRequest,
    http::Request,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tower::ServiceExt;

mod name_length;
mod name_whitespace;
mod names;
mod visibility;

fn router(pool: &PgPool) -> Router {
    crate::app(AppState::for_test(pool.clone()))
}

async fn body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 32 * 1024).await.unwrap()).unwrap()
}

async fn request(app: &Router, method: &str, path: &str, token: &str, input: Value) -> Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::from(input.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn organization(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (organization_id, name) VALUES ($1, 'Organization')")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    id
}

// Members and sessions are test fixtures, not a membership-management API.
// Allow shared member ids across tenants to expose missing composite-key joins.
async fn member(pool: &PgPool, organization_id: Uuid, id: Uuid, role: &str) -> String {
    sqlx::query(
        "INSERT INTO users (organization_id, id, email, name, password_hash, role) \
         VALUES ($1, $2, $3, 'Member', 'unused-in-session-fixture', $4)",
    )
    .bind(organization_id)
    .bind(id)
    .bind(format!("{id}@example.com"))
    .bind(role)
    .execute(pool)
    .await
    .unwrap();
    let token = format!(
        "{organization_id}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    sqlx::query("INSERT INTO sessions (organization_id, token_hash, user_id) VALUES ($1, $2, $3)")
        .bind(organization_id)
        .bind(Sha256::digest(token.as_bytes()).to_vec())
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    token
}

async fn create(app: &Router, token: &str, name: &str, visibility: &str) -> Value {
    let response = request(
        app,
        "POST",
        "/api/v1/channels",
        token,
        json!({"name": name, "visibility": visibility}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let channel = body(response).await;
    assert!(Uuid::parse_str(channel["id"].as_str().unwrap()).is_ok());
    assert_eq!(channel.as_object().unwrap().len(), 3);
    assert_eq!(channel["name"], name);
    assert_eq!(channel["visibility"], visibility);
    channel
}

async fn list(app: &Router, token: &str) -> Value {
    let response = request(app, "GET", "/api/v1/channels", token, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    body(response).await
}

#[tokio::test]
async fn channels_require_authentication_without_database_access() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let app = router(&pool);
    for method in ["GET", "POST"] {
        for authorization in [None, Some("Bearer invalid"), Some("Basic invalid")] {
            let mut request = Request::builder().method(method).uri("/api/v1/channels");
            if let Some(value) = authorization {
                request = request.header(header::AUTHORIZATION, value);
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(
                body(response).await,
                json!({"error": "invalid credentials"})
            );
        }
    }
}

#[sqlx::test]
async fn channel_list_database_failure_returns_generic_500(pool: PgPool) {
    let app = router(&pool);
    let organization_id = organization(&pool).await;
    let token = member(&pool, organization_id, Uuid::new_v4(), "member").await;
    assert_eq!(list(&app, &token).await, json!({"channels": []}));
    sqlx::query("ALTER TABLE channels RENAME COLUMN name TO injected_unavailable_name")
        .execute(&pool)
        .await
        .unwrap();
    let response = request(&app, "GET", "/api/v1/channels", &token, Value::Null).await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(body(response).await, json!({"error": "internal error"}));
}

#[tokio::test]
async fn channel_json_rejections_use_error_body() {
    for (content_type, input, status) in [
        ("application/json", "{".into(), StatusCode::BAD_REQUEST),
        ("application/json", "{}".into(), StatusCode::BAD_REQUEST),
        (
            "application/json",
            json!({"name": "Channel", "visibility": "secret"}).to_string(),
            StatusCode::BAD_REQUEST,
        ),
        (
            "application/json",
            json!({"name": 1, "visibility": "public"}).to_string(),
            StatusCode::BAD_REQUEST,
        ),
        (
            "application/json",
            json!({"name": "Channel", "visibility": "public", "organization_id": Uuid::new_v4()})
                .to_string(),
            StatusCode::BAD_REQUEST,
        ),
        (
            "text/plain",
            json!({"name": "Channel", "visibility": "public"}).to_string(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
    ] {
        let request = Request::post("/api/v1/channels")
            .header(header::CONTENT_TYPE, content_type)
            .body(Body::from(input))
            .unwrap();
        let error = match ApiJson::<CreateChannelRequest>::from_request(request, &()).await {
            Err(error) => error.into_response(),
            Ok(_) => panic!("invalid input accepted"),
        };
        assert_eq!(error.status(), status);
        assert_eq!(error.headers()[header::CONTENT_TYPE], "application/json");
        assert!(body(error).await["error"].is_string());
    }
}

#[sqlx::test]
async fn private_channel_is_listed_only_for_its_creator(pool: PgPool) {
    let app = router(&pool);
    let organization_id = organization(&pool).await;
    let creator_id = Uuid::new_v4();
    let creator = member(&pool, organization_id, creator_id, "member").await;
    let other = member(&pool, organization_id, Uuid::new_v4(), "member").await;

    assert_eq!(list(&app, &creator).await, json!({"channels": []}));
    let public = create(&app, &creator, "A public", "public").await;
    let private = create(&app, &creator, "B private", "private").await;
    assert_eq!(
        list(&app, &creator).await,
        json!({"channels": [public.clone(), private.clone()]})
    );
    assert_eq!(list(&app, &other).await, json!({"channels": [public]}));

    let memberships: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT channel_id, member_id FROM channel_members WHERE organization_id = $1",
    )
    .bind(organization_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        memberships,
        vec![(
            Uuid::parse_str(private["id"].as_str().unwrap()).unwrap(),
            creator_id
        )]
    );
}

#[sqlx::test]
async fn channels_cannot_access_or_forge_another_organization(pool: PgPool) {
    let app = router(&pool);
    let first = organization(&pool).await;
    let second = organization(&pool).await;
    let shared_member_id = Uuid::new_v4();
    let token_a = member(&pool, first, shared_member_id, "member").await;
    let token_b = member(&pool, second, shared_member_id, "member").await;
    let public_a = create(&app, &token_a, "A public", "public").await;
    let private_a = create(&app, &token_a, "A private", "private").await;
    let public_b = create(&app, &token_b, "B public", "public").await;
    let private_b = create(&app, &token_b, "B private", "private").await;

    for (token, foreign, expected) in [
        (&token_a, second, json!({"channels": [private_a, public_a]})),
        (&token_b, first, json!({"channels": [private_b, public_b]})),
    ] {
        assert_eq!(list(&app, token).await, expected);
        let response = app
            .clone()
            .oneshot(
                Request::get(format!("/api/v1/channels?organization_id={foreign}"))
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .header("x-organization-id", foreign.to_string())
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body(response).await, expected);
        let response = request(
            &app,
            "POST",
            "/api/v1/channels",
            token,
            json!({"name": "Forged", "visibility": "private", "organization_id": foreign}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body(response).await, json!({"error": "invalid input"}));
    }

    // Unknown query/header tenant scope cannot redirect a valid create either.
    let response = app
        .clone()
        .oneshot(
            Request::post(format!("/api/v1/channels?organization_id={second}"))
                .header(header::COOKIE, format!("fukulow_session={token_a}"))
                .header("x-organization-id", second.to_string())
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"name": "Scoped", "visibility": "public"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let created = body(response).await;
    let stored_organization: Uuid = sqlx::query_scalar(
        "SELECT organization_id FROM channels WHERE organization_id = $1 AND id = $2",
    )
    .bind(first)
    .bind(Uuid::parse_str(created["id"].as_str().unwrap()).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored_organization, first);
    let foreign_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM channels WHERE organization_id = $1")
            .bind(second)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(foreign_count, 2);
}

#[sqlx::test]
async fn foreign_membership_does_not_grant_private_channel_visibility(pool: PgPool) {
    let app = router(&pool);
    let first = organization(&pool).await;
    let second = organization(&pool).await;
    let shared_member_id = Uuid::new_v4();
    let reader_a = member(&pool, first, shared_member_id, "member").await;
    let reader_b = member(&pool, second, shared_member_id, "member").await;
    let creator = member(&pool, first, Uuid::new_v4(), "member").await;
    let private = create(&app, &creator, "Private", "private").await;
    let channel_id = Uuid::parse_str(private["id"].as_str().unwrap()).unwrap();
    // Composite keys permit equal local ids in different Organizations. Neither
    // the Channel id nor the Member id alone can establish private membership.
    sqlx::query(
        "INSERT INTO channels (organization_id, id, name, visibility) VALUES ($1, $2, 'Private', 'private')",
    ).bind(second).bind(channel_id).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO channel_members (organization_id, channel_id, member_id) VALUES ($1, $2, $3)",
    )
    .bind(second)
    .bind(channel_id)
    .bind(shared_member_id)
    .execute(&pool)
    .await
    .unwrap();

    assert_eq!(list(&app, &reader_a).await, json!({"channels": []}));
    assert_eq!(list(&app, &reader_b).await, json!({"channels": [private]}));
}

#[sqlx::test]
async fn channel_body_limit_and_content_type_rejections_do_not_write(pool: PgPool) {
    let app = router(&pool);
    let organization_id = organization(&pool).await;
    let token = member(&pool, organization_id, Uuid::new_v4(), "member").await;
    for (content_type, name, status, error) in [
        (
            "application/json",
            "x".repeat(16 * 1024),
            StatusCode::PAYLOAD_TOO_LARGE,
            "request body too large",
        ),
        (
            "text/plain",
            "Channel".into(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "expected application/json",
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/channels")
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(header::CONTENT_TYPE, content_type)
                    .body(Body::from(
                        json!({"name": name, "visibility": "public"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(body(response).await, json!({"error": error}));
    }
    assert_eq!(list(&app, &token).await, json!({"channels": []}));
}

#[sqlx::test]
async fn channel_memberships_reject_cross_organization_references(pool: PgPool) {
    let app = router(&pool);
    let first = organization(&pool).await;
    let second = organization(&pool).await;
    let member_a = Uuid::new_v4();
    let member_b = Uuid::new_v4();
    let token_a = member(&pool, first, member_a, "member").await;
    let token_b = member(&pool, second, member_b, "member").await;
    let channel_a = create(&app, &token_a, "Private A", "private").await;
    let channel_b = create(&app, &token_b, "Private B", "private").await;
    let channel_a = Uuid::parse_str(channel_a["id"].as_str().unwrap()).unwrap();
    let channel_b = Uuid::parse_str(channel_b["id"].as_str().unwrap()).unwrap();
    for (channel_id, member_id) in [(channel_a, member_b), (channel_b, member_a)] {
        let error = sqlx::query(
            "INSERT INTO channel_members (organization_id, channel_id, member_id) VALUES ($1, $2, $3)",
        ).bind(first).bind(channel_id).bind(member_id).execute(&pool).await.unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23503")
        );
    }
    let error = sqlx::query(
        "INSERT INTO channels (organization_id, id, name, visibility) VALUES ($1, $2, 'Orphan', 'public')",
    ).bind(Uuid::new_v4()).bind(Uuid::new_v4()).execute(&pool).await.unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23503")
    );
}

#[sqlx::test]
async fn private_channel_creation_rolls_back_if_membership_insert_fails(pool: PgPool) {
    let app = router(&pool);
    let organization_id = organization(&pool).await;
    let token = member(&pool, organization_id, Uuid::new_v4(), "member").await;
    // Simulate a membership constraint failure after the channel INSERT succeeds.
    sqlx::query("ALTER TABLE channel_members ADD CONSTRAINT reject_test_memberships CHECK (false)")
        .execute(&pool)
        .await
        .unwrap();
    let response = request(
        &app,
        "POST",
        "/api/v1/channels",
        &token,
        json!({"name": "Rollback", "visibility": "private"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body(response).await, json!({"error": "internal error"}));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM channels WHERE organization_id = $1")
        .bind(organization_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}
