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

mod managers;
mod membership;
mod name_length;
mod name_nonempty;
mod name_whitespace;
mod names;
mod role_changes;
mod visibility;

async fn router(pool: &PgPool) -> Router {
    crate::app(AppState::for_test(pool.clone()).await)
}

async fn body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 32 * 1024).await.unwrap()).unwrap()
}

async fn request(app: &Router, method: &str, path: &str, token: &str, input: Value) -> Response {
    let path = scoped_path(path, token);
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(&path)
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
    let account_id = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, email, password_hash) VALUES ($1, $2, 'unused')")
        .bind(account_id)
        .bind(format!("{account_id}@example.com"))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (organization_id, id, account_id, name, role) VALUES ($1, $2, $3, 'Member', $4)")
        .bind(organization_id).bind(id).bind(account_id).bind(role).execute(pool).await.unwrap();
    // The prefix is fixture metadata for explicit Organization route construction.
    let token = format!(
        "{organization_id}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    sqlx::query("INSERT INTO account_sessions (token_hash, account_id) VALUES ($1, $2)")
        .bind(Sha256::digest(token.as_bytes()).to_vec())
        .bind(account_id)
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
    assert_eq!(channel.as_object().unwrap().len(), 4);
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

fn unread_channel(channel: &Value) -> Value {
    let mut channel = channel.clone();
    channel["read_seq"] = json!(0);
    channel["as_of_seq"] = json!(0);
    channel["main_unread_count"] = json!(0);
    channel["unread_count"] = json!(0);
    channel
}

#[tokio::test]
async fn channels_require_authentication_without_database_access() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let app = crate::app(AppState::with_test_pool(pool));
    for method in ["GET", "POST"] {
        for authorization in [None, Some("Bearer invalid"), Some("Basic invalid")] {
            let mut request = Request::builder()
                .method(method)
                .uri("/api/v1/orgs/00000000-0000-0000-0000-000000000000/channels");
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
    let app = router(&pool).await;
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
    let pools = crate::test_support::TestPools::new(pool).await;
    let pool = pools.admin;
    let app = router(&pools.app).await;
    let organization_id = organization(&pool).await;
    let creator_id = Uuid::new_v4();
    let creator = member(&pool, organization_id, creator_id, "member").await;
    let other = member(&pool, organization_id, Uuid::new_v4(), "member").await;

    assert_eq!(list(&app, &creator).await, json!({"channels": []}));
    let public = create(&app, &creator, "A public", "public").await;
    let private = create(&app, &creator, "B private", "private").await;
    assert_eq!(
        list(&app, &creator).await,
        json!({"channels": [unread_channel(&public), unread_channel(&private)]})
    );
    assert_eq!(
        list(&app, &other).await,
        json!({"channels": [unread_channel(&public)]})
    );

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
    pools.app.close().await;
}

#[sqlx::test]
async fn channels_cannot_access_or_forge_another_organization(pool: PgPool) {
    let app = router(&pool).await;
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
        (
            &token_a,
            second,
            json!({"channels": [unread_channel(&private_a), unread_channel(&public_a)]}),
        ),
        (
            &token_b,
            first,
            json!({"channels": [unread_channel(&private_b), unread_channel(&public_b)]}),
        ),
    ] {
        assert_eq!(list(&app, token).await, expected);
        let response = app
            .clone()
            .oneshot(
                Request::get(scoped_path(
                    &format!("/api/v1/channels?organization_id={foreign}"),
                    token,
                ))
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
            Request::post(format!(
                "/api/v1/orgs/{first}/channels?organization_id={second}"
            ))
            .header(header::COOKIE, format!("__Host-fukulow_session={token_a}"))
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
    let app = router(&pool).await;
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
    let mut private = private;
    for capability in [
        "can_add_members",
        "can_remove_members",
        "can_manage_managers",
    ] {
        private["capabilities"][capability] = json!({"allowed":false,"reason":"forbidden"});
    }
    assert_eq!(
        list(&app, &reader_b).await,
        json!({"channels": [unread_channel(&private)]})
    );
}

#[sqlx::test]
async fn channel_body_limit_and_content_type_rejections_do_not_write(pool: PgPool) {
    let app = router(&pool).await;
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
                Request::post(scoped_path("/api/v1/channels", &token))
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
    let app = router(&pool).await;
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
    let app = router(&pool).await;
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

fn scoped_path(path: &str, token: &str) -> String {
    if path.starts_with("/api/v1/channels") || path.starts_with("/api/v1/ws") {
        let organization = token
            .split_once('.')
            .map(|(id, _)| id)
            .expect("test token must carry its Organization scope");
        path.replacen("/api/v1/", &format!("/api/v1/orgs/{organization}/"), 1)
    } else {
        path.to_owned()
    }
}

async fn extract_auth(state: AppState, token: &str) -> Auth {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(sender)));
    let app = Router::new()
        .route(
            "/api/v1/orgs/{org}/channels",
            axum::routing::get(move |auth: Auth| {
                let sender = sender.clone();
                async move {
                    sender
                        .lock()
                        .unwrap()
                        .take()
                        .unwrap()
                        .send(auth)
                        .ok()
                        .unwrap();
                    StatusCode::OK
                }
            }),
        )
        .with_state(state);
    assert_eq!(
        request(&app, "GET", "/api/v1/channels", token, Value::Null)
            .await
            .status(),
        StatusCode::OK
    );
    receiver.await.unwrap()
}

#[sqlx::test]
async fn reactivation_keeps_member_identity_without_restoring_private_channel_permissions(
    pool: PgPool,
) {
    let app = router(&pool).await;
    let organization = organization(&pool).await;
    let id = Uuid::new_v4();
    let token = member(&pool, organization, id, "member").await;
    let private = create(&app, &token, "Private history", "private").await;
    let public = create(&app, &token, "Public history", "public").await;
    assert_eq!(
        list(&app, &token).await["channels"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(organization)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(&app, "GET", "/api/v1/channels", &token, Value::Null)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
        .bind(organization)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        list(&app, &token).await,
        json!({"channels":[unread_channel(&public)]})
    );
    let private_id = private["id"].as_str().unwrap().parse::<Uuid>().unwrap();
    let public_id = public["id"].as_str().unwrap().parse::<Uuid>().unwrap();
    assert!(
        is_visible(&pool, organization, (id, 1), private_id)
            .await
            .unwrap()
            != Some(true)
    );
    assert!(
        visible_members(&pool, organization, private_id, &[(id, 1)])
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        is_visible(&pool, organization, (id, 1), public_id)
            .await
            .unwrap()
            == Some(true)
    );
    assert_eq!(
        visible_members(&pool, organization, public_id, &[(id, 1)])
            .await
            .unwrap(),
        vec![(id, 1)]
    );
    for (channel, status) in [
        (private_id, StatusCode::NOT_FOUND),
        (public_id, StatusCode::OK),
    ] {
        let response = request(
            &app,
            "GET",
            &format!("/api/v1/channels/{channel}/messages"),
            &token,
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), status);
    }
    let response = request(
        &app,
        "POST",
        &format!("/api/v1/channels/{private_id}/messages"),
        &token,
        json!({"client_message_id":Uuid::new_v4(),"body":"Stale grant must not send"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut upgrade = format!("ws://{address}/api/v1/orgs/{organization}/ws")
        .into_client_request()
        .unwrap();
    upgrade.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(upgrade).await.unwrap();
    let ready = socket.next().await.unwrap().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(ready.to_text().unwrap()).unwrap()["type"],
        "activity_ready"
    );
    for (channel_id, expected) in [(private_id, "error"), (public_id, "subscribed")] {
        socket
            .send(Message::text(
                json!({"type":"subscribe","channel_id":channel_id,"after_seq":0}).to_string(),
            ))
            .await
            .unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let event: Value = serde_json::from_str(event.to_text().unwrap()).unwrap();
        assert_eq!(event["type"], expected);
        assert_eq!(event["channel_id"], channel_id.to_string());
        if expected == "error" {
            assert_eq!(event["code"], "channel_not_found");
        }
    }

    // A new grant explicitly records the current Member revision.
    sqlx::query("UPDATE channel_members cm SET membership_revision=u.membership_revision FROM users u WHERE cm.organization_id=$1 AND cm.channel_id=$2 AND cm.member_id=$3 AND u.organization_id=cm.organization_id AND u.id=cm.member_id")
        .bind(organization).bind(private_id).bind(id).execute(&pool).await.unwrap();
    assert!(
        is_visible(&pool, organization, (id, 1), private_id)
            .await
            .unwrap()
            == Some(true)
    );
    assert_eq!(
        visible_members(&pool, organization, private_id, &[(id, 1)])
            .await
            .unwrap(),
        vec![(id, 1)]
    );
    socket
        .send(Message::text(
            json!({"type":"subscribe","channel_id":private_id,"after_seq":0}).to_string(),
        ))
        .await
        .unwrap();
    let event = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let event: Value = serde_json::from_str(event.to_text().unwrap()).unwrap();
    assert_eq!(event["type"], "subscribed");
    assert_eq!(event["channel_id"], private_id.to_string());
    let app = router(&pool).await;
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/v1/channels/{private_id}/messages"),
            &token,
            Value::Null
        )
        .await
        .status(),
        StatusCode::OK
    );
    for channel_id in [private_id, public_id] {
        assert_eq!(
            request(
                &app,
                "POST",
                &format!("/api/v1/channels/{channel_id}/messages"),
                &token,
                json!({"client_message_id":Uuid::new_v4(),"body":"Current authorization can send"})
            )
            .await
            .status(),
            StatusCode::CREATED
        );
    }
    socket.close(None).await.unwrap();
    server.abort();
    let historical_grant: Uuid = sqlx::query_scalar(
        "SELECT member_id FROM channel_members WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(organization)
    .bind(private["id"].as_str().unwrap().parse::<Uuid>().unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(historical_grant, id);
}

mod management;
