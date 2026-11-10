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

mod admission;

fn router(pool: &PgPool) -> Router {
    crate::app(AppState::for_test(pool.clone()))
}

async fn body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 256 * 1024).await.unwrap()).unwrap()
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

// Fixture SQL deliberately allows the same ids in separate Organizations.
async fn organization(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (organization_id, name) VALUES ($1, 'Organization')")
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn member(pool: &PgPool, organization_id: Uuid, id: Uuid) -> String {
    sqlx::query(
        "INSERT INTO users (organization_id, id, email, name, password_hash, role) \
         VALUES ($1, $2, $3, 'Member', 'unused', 'member')",
    )
    .bind(organization_id)
    .bind(id)
    .bind(format!("{id}@example.com"))
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

async fn channel(pool: &PgPool, organization_id: Uuid, id: Uuid, creator: Uuid, private: bool) {
    sqlx::query(
        "INSERT INTO channels (organization_id, id, name, visibility) VALUES ($1, $2, $3, $4)",
    )
    .bind(organization_id)
    .bind(id)
    .bind(format!("Channel {id}"))
    .bind(if private { "private" } else { "public" })
    .execute(pool)
    .await
    .unwrap();
    if private {
        sqlx::query("INSERT INTO channel_members (organization_id, channel_id, member_id) VALUES ($1, $2, $3)")
            .bind(organization_id).bind(id).bind(creator).execute(pool).await.unwrap();
    }
}

async fn fixture(pool: &PgPool) -> (Router, Uuid, Uuid, Uuid, String) {
    let organization_id = organization(pool).await;
    let sender = Uuid::new_v4();
    let token = member(pool, organization_id, sender).await;
    let channel_id = Uuid::new_v4();
    channel(pool, organization_id, channel_id, sender, false).await;
    (router(pool), organization_id, sender, channel_id, token)
}

fn input(client_message_id: Uuid, text: &str) -> Value {
    json!({"client_message_id": client_message_id, "body": text})
}

async fn send(app: &Router, token: &str, channel_id: Uuid, value: Value) -> Response {
    request(
        app,
        "POST",
        &format!("/api/v1/channels/{channel_id}/messages"),
        token,
        value,
    )
    .await
}

async fn sent(app: &Router, token: &str, channel_id: Uuid, value: Value) -> Value {
    let response = send(app, token, channel_id, value).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    body(response).await
}

async fn list(app: &Router, token: &str, channel_id: Uuid, query: &str) -> Value {
    let response = request(
        app,
        "GET",
        &format!("/api/v1/channels/{channel_id}/messages{query}"),
        token,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    body(response).await
}

async fn assert_error(response: Response, status: StatusCode) {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let value = body(response).await;
    assert_eq!(value.as_object().unwrap().len(), 1);
    assert!(value["error"].is_string());
}

#[tokio::test]
async fn messages_require_authentication_without_database_access() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let app = router(&pool);
    for method in ["GET", "POST"] {
        for authorization in [None, Some("Bearer invalid"), Some("Basic invalid")] {
            let mut request = Request::builder()
                .method(method)
                .uri("/api/v1/channels/not-a-uuid/messages");
            if let Some(value) = authorization {
                request = request.header(header::AUTHORIZATION, value);
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_error(response, StatusCode::UNAUTHORIZED).await;
        }
    }
}

#[test]
fn message_query_validation_matches_contract() {
    let query = |after_seq, before_seq, limit| ListMessagesQuery {
        after_seq,
        before_seq,
        limit,
    };
    for valid in [
        query(None, None, None),
        query(Some(0), None, Some(1)),
        query(None, Some(1), Some(200)),
        query(Some(i64::MAX), None, None),
    ] {
        assert!(valid.validate().is_ok());
    }
    assert_eq!(query(None, None, None).validate().unwrap(), 50);
    for invalid in [
        query(Some(0), Some(1), None),
        query(Some(-1), None, None),
        query(None, Some(0), None),
        query(None, None, Some(0)),
        query(None, None, Some(201)),
    ] {
        assert!(matches!(
            invalid.validate(),
            Err(MessageError::InvalidInput)
        ));
    }
}

#[sqlx::test]
async fn message_list_database_failure_returns_generic_500(pool: PgPool) {
    let (app, _, _, channel_id, token) = fixture(&pool).await;
    assert_eq!(
        list(&app, &token, channel_id, "").await,
        json!({"messages": [], "has_more": false})
    );
    sqlx::query("ALTER TABLE messages RENAME COLUMN body TO injected_unavailable_body")
        .execute(&pool)
        .await
        .unwrap();
    let response = request(
        &app,
        "GET",
        &format!("/api/v1/channels/{channel_id}/messages"),
        &token,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(body(response).await, json!({"error": "internal error"}));
}

#[tokio::test]
async fn message_json_rejections_use_error_body() {
    for (content_type, input, status) in [
        ("application/json", "{".into(), StatusCode::BAD_REQUEST),
        ("application/json", "{}".into(), StatusCode::BAD_REQUEST),
        ("application/json", json!({"client_message_id": "bad", "body": "hi"}).to_string(), StatusCode::BAD_REQUEST),
        ("application/json", json!({"client_message_id": Uuid::new_v4(), "body": 1}).to_string(), StatusCode::BAD_REQUEST),
        ("application/json", json!({"client_message_id": Uuid::new_v4(), "body": "hi", "organization_id": Uuid::new_v4()}).to_string(), StatusCode::BAD_REQUEST),
        ("text/plain", "{}".into(), StatusCode::UNSUPPORTED_MEDIA_TYPE),
    ] {
        let request = Request::post("/").header(header::CONTENT_TYPE, content_type).body(Body::from(input)).unwrap();
        let error = match ApiJson::<SendMessageRequest>::from_request(request, &()).await {
            Err(error) => error.into_response(),
            Ok(_) => panic!("invalid input accepted"),
        };
        assert_error(error, status).await;
    }
}

#[tokio::test]
async fn message_body_validation_matches_contract() {
    let schema =
        serde_json::to_value(<crate::openapi::ApiDoc as utoipa::OpenApi>::openapi()).unwrap();
    let body_schema = &schema["components"]["schemas"]["SendMessageRequest"]["properties"]["body"];
    assert_eq!(body_schema["minLength"], 1);
    assert_eq!(body_schema["maxLength"], 4000);
    for text in [
        "hello\0world".into(),
        "".into(),
        " \t\r\n\u{2003}".into(),
        "🦉".repeat(4001),
    ] {
        let input = SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            body: text,
        };
        let error = input.validate().unwrap_err().into_response();
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body(error).await, json!({"error": "invalid input"}));
    }
    for text in [
        "a".into(),
        " \nhello\t ".into(),
        "x".repeat(4000),
        "🦉".repeat(4000),
        "e\u{301}".repeat(2000),
    ] {
        let input = SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            body: text.clone(),
        };
        input.validate().unwrap();
        assert_eq!(input.body, text);
    }
}

#[sqlx::test]
async fn invalid_message_bodies_write_nothing_and_do_not_allocate_sequences(pool: PgPool) {
    let (app, organization_id, _, channel_id, token) = fixture(&pool).await;
    for expected_seq in [None, Some(1_i64)] {
        if expected_seq.is_some() {
            sent(
                &app,
                &token,
                channel_id,
                input(Uuid::new_v4(), "existing message"),
            )
            .await;
        }
        for text in [
            "hello\0world".into(),
            "".into(),
            " \t\r\n\u{2003}".into(),
            "🦉".repeat(4001),
        ] {
            let key = Uuid::new_v4();
            let response = send(&app, &token, channel_id, input(key, &text)).await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(body(response).await, json!({"error": "invalid input"}));
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM messages WHERE organization_id = $1 AND channel_id = $2",
            )
            .bind(organization_id)
            .bind(channel_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(count, expected_seq.unwrap_or(0));
            let seq: Option<i64> = sqlx::query_scalar("SELECT seq FROM channel_message_sequences WHERE organization_id = $1 AND channel_id = $2")
                .bind(organization_id).bind(channel_id).fetch_optional(&pool).await.unwrap();
            assert_eq!(seq, expected_seq);
            // A rejected body must not reserve the client's idempotency key either.
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages WHERE organization_id = $1 AND client_message_id = $2")
                .bind(organization_id).bind(key).fetch_one(&pool).await.unwrap();
            assert_eq!(count, 0);
        }
    }
}

#[sqlx::test]
async fn message_at_body_limit_preserves_whitespace_and_idempotent_retries(pool: PgPool) {
    let (app, organization_id, _, channel_id, token) = fixture(&pool).await;
    let key = Uuid::new_v4();
    let text = format!(" \n{}\t", "🦉".repeat(3997));
    assert_eq!(text.chars().count(), 4000);
    let first = sent(&app, &token, channel_id, input(key, &text)).await;
    assert_eq!(first["body"], text);
    assert_eq!(first["seq"], 1);
    assert_eq!(
        sent(&app, &token, channel_id, input(key, &text)).await,
        first
    );
    assert_error(
        send(&app, &token, channel_id, input(key, text.trim())).await,
        StatusCode::CONFLICT,
    )
    .await;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM messages WHERE organization_id = $1 AND channel_id = $2",
    )
    .bind(organization_id)
    .bind(channel_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
    let seq: i64 = sqlx::query_scalar(
        "SELECT seq FROM channel_message_sequences WHERE organization_id = $1 AND channel_id = $2",
    )
    .bind(organization_id)
    .bind(channel_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(seq, 1);
    assert_eq!(
        sent(&app, &token, channel_id, input(Uuid::new_v4(), "next")).await["seq"],
        2
    );
}

#[sqlx::test]
async fn messages_deny_cross_organization_send_and_list(pool: PgPool) {
    let (app, organization_id, sender, channel_id, token) = fixture(&pool).await;
    let second = organization(&pool).await;
    let foreign = member(&pool, second, sender).await;
    sent(
        &app,
        &token,
        channel_id,
        input(Uuid::new_v4(), "private to tenant"),
    )
    .await;
    for denied in [channel_id, Uuid::new_v4()] {
        assert_error(
            send(&app, &foreign, denied, input(Uuid::new_v4(), "forbidden")).await,
            StatusCode::NOT_FOUND,
        )
        .await;
        assert_error(
            request(
                &app,
                "GET",
                &format!("/api/v1/channels/{denied}/messages?after_seq=0"),
                &foreign,
                Value::Null,
            )
            .await,
            StatusCode::NOT_FOUND,
        )
        .await;
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM messages WHERE organization_id = $1")
        .bind(organization_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[sqlx::test]
async fn messages_deny_private_channel_nonmember_send_and_list(pool: PgPool) {
    let (app, organization_id, sender, _, token) = fixture(&pool).await;
    let private = Uuid::new_v4();
    channel(&pool, organization_id, private, sender, true).await;
    let other = member(&pool, organization_id, Uuid::new_v4()).await;
    let key = Uuid::new_v4();
    let original = sent(&app, &token, private, input(key, "secret")).await;
    assert_error(
        send(&app, &other, private, input(key, "secret")).await,
        StatusCode::NOT_FOUND,
    )
    .await;
    for query in ["", "?after_seq=0", "?before_seq=2"] {
        assert_error(
            request(
                &app,
                "GET",
                &format!("/api/v1/channels/{private}/messages{query}"),
                &other,
                Value::Null,
            )
            .await,
            StatusCode::NOT_FOUND,
        )
        .await;
    }
    assert_eq!(
        list(&app, &token, private, "").await["messages"],
        json!([original])
    );
    // Even an exact retry must be denied after membership is removed.
    sqlx::query("DELETE FROM channel_members WHERE organization_id = $1 AND channel_id = $2 AND member_id = $3")
        .bind(organization_id).bind(private).bind(sender).execute(&pool).await.unwrap();
    assert_error(
        send(&app, &token, private, input(key, "secret")).await,
        StatusCode::NOT_FOUND,
    )
    .await;
}

#[sqlx::test]
async fn equal_ids_in_two_organizations_do_not_collide(pool: PgPool) {
    let (app, first, sender, channel_id, first_token) = fixture(&pool).await;
    let second = organization(&pool).await;
    let second_token = member(&pool, second, sender).await;
    channel(&pool, second, channel_id, sender, true).await;
    let client_id = Uuid::new_v4();
    let a = sent(&app, &first_token, channel_id, input(client_id, "first")).await;
    let mut b = sent(&app, &second_token, channel_id, input(client_id, "second")).await;
    assert_ne!(a["id"], b["id"]);
    // Fixture only: force equal canonical ids too, exercising the composite primary key.
    sqlx::query("UPDATE messages SET id = $3 WHERE organization_id = $1 AND channel_id = $2 AND client_message_id = $4")
        .bind(second).bind(channel_id).bind(Uuid::parse_str(a["id"].as_str().unwrap()).unwrap())
        .bind(client_id).execute(&pool).await.unwrap();
    b["id"] = a["id"].clone();
    assert_eq!(
        sent(&app, &second_token, channel_id, input(client_id, "second")).await,
        b
    );
    assert_eq!(a["seq"], 1);
    assert_eq!(b["seq"], 1);
    assert_eq!(
        list(&app, &first_token, channel_id, "?after_seq=0").await["messages"],
        json!([a])
    );
    assert_eq!(
        list(&app, &second_token, channel_id, "?before_seq=2").await["messages"],
        json!([b])
    );
    // A membership for equal ids in the other tenant must not grant access here.
    let private = Uuid::new_v4();
    channel(&pool, first, private, sender, true).await;
    channel(&pool, second, private, sender, true).await;
    sqlx::query("DELETE FROM channel_members WHERE organization_id = $1 AND channel_id = $2")
        .bind(first)
        .bind(private)
        .execute(&pool)
        .await
        .unwrap();
    assert_error(
        send(
            &app,
            &first_token,
            private,
            input(Uuid::new_v4(), "forbidden"),
        )
        .await,
        StatusCode::NOT_FOUND,
    )
    .await;
    assert_error(
        request(
            &app,
            "GET",
            &format!("/api/v1/channels/{private}/messages"),
            &first_token,
            Value::Null,
        )
        .await,
        StatusCode::NOT_FOUND,
    )
    .await;
}

#[sqlx::test]
async fn committed_send_retry_returns_canonical_message_without_sequence_allocation(pool: PgPool) {
    let (app, _, sender, channel_id, token) = fixture(&pool).await;
    let key = Uuid::new_v4();
    // The first response is not used to choose the retry key, simulating a lost response.
    let first_response = send(&app, &token, channel_id, input(key, "hello\n世界")).await;
    let retry = sent(&app, &token, channel_id, input(key, "hello\n世界")).await;
    assert_eq!(body(first_response).await, retry);
    assert_eq!(retry["client_message_id"], json!(key));
    assert_eq!(retry["sender"], json!(sender));
    assert_eq!(retry["channel_id"], json!(channel_id));
    assert_eq!(retry["seq"], 1);
    assert!(retry["topic_id"].is_null());
    assert!(retry["created_at"].as_str().unwrap().ends_with('Z'));
    let next = sent(&app, &token, channel_id, input(Uuid::new_v4(), "next")).await;
    assert_eq!(next["seq"], 2);
    assert_eq!(
        list(&app, &token, channel_id, "").await["messages"],
        json!([retry, next])
    );
}

#[sqlx::test]
async fn reused_client_id_conflicts_on_different_body_or_channel(pool: PgPool) {
    let (app, organization_id, sender, channel_id, token) = fixture(&pool).await;
    let other_channel = Uuid::new_v4();
    channel(&pool, organization_id, other_channel, sender, false).await;
    let key = Uuid::new_v4();
    sent(&app, &token, channel_id, input(key, "original")).await;
    assert_error(
        send(&app, &token, channel_id, input(key, "different")).await,
        StatusCode::CONFLICT,
    )
    .await;
    assert_error(
        send(&app, &token, other_channel, input(key, "original")).await,
        StatusCode::CONFLICT,
    )
    .await;
    assert_eq!(
        sent(
            &app,
            &token,
            other_channel,
            input(Uuid::new_v4(), "other channel")
        )
        .await["seq"],
        1
    );
    let other = member(&pool, organization_id, Uuid::new_v4()).await;
    assert_eq!(
        sent(&app, &other, channel_id, input(key, "independent sender")).await["seq"],
        2
    );
}

async fn concurrent_sends(
    app: &Router,
    token: &str,
    channels: &[Uuid],
    same_key: bool,
) -> Vec<Response> {
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(channels.len()));
    let key = Uuid::new_v4();
    let mut tasks = tokio::task::JoinSet::new();
    for &channel_id in channels {
        let app = app.clone();
        let token = token.to_owned();
        let barrier = barrier.clone();
        tasks.spawn(async move {
            barrier.wait().await;
            send(
                &app,
                &token,
                channel_id,
                input(if same_key { key } else { Uuid::new_v4() }, "concurrent"),
            )
            .await
        });
    }
    let mut responses = Vec::new();
    while let Some(response) = tasks.join_next().await {
        responses.push(response.unwrap());
    }
    responses
}

#[sqlx::test]
async fn concurrent_duplicate_sends_create_one_message_and_consume_one_sequence(pool: PgPool) {
    let (app, _, _, channel_id, token) = fixture(&pool).await;
    let mut canonical = None;
    for response in concurrent_sends(&app, &token, &[channel_id; 24], true).await {
        assert_eq!(response.status(), StatusCode::CREATED);
        let value = body(response).await;
        if let Some(expected) = &canonical {
            assert_eq!(&value, expected);
        } else {
            canonical = Some(value);
        }
    }
    assert_eq!(
        list(&app, &token, channel_id, "").await["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        sent(&app, &token, channel_id, input(Uuid::new_v4(), "next")).await["seq"],
        2
    );
}

#[sqlx::test]
async fn concurrent_cross_channel_duplicate_conflicts_without_sequence_gap(pool: PgPool) {
    let (app, organization_id, sender, first, token) = fixture(&pool).await;
    let second = Uuid::new_v4();
    channel(&pool, organization_id, second, sender, false).await;
    let responses = concurrent_sends(&app, &token, &[first, second], true).await;
    assert_eq!(
        responses
            .iter()
            .filter(|r| r.status() == StatusCode::CREATED)
            .count(),
        1
    );
    assert_eq!(
        responses
            .iter()
            .filter(|r| r.status() == StatusCode::CONFLICT)
            .count(),
        1
    );
    for channel_id in [first, second] {
        let count = list(&app, &token, channel_id, "").await["messages"]
            .as_array()
            .unwrap()
            .len();
        assert_eq!(
            sent(&app, &token, channel_id, input(Uuid::new_v4(), "next")).await["seq"],
            count + 1
        );
    }
}

#[sqlx::test]
async fn concurrent_sends_allocate_unique_consecutive_channel_sequences(pool: PgPool) {
    let app_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let (app, _, _, channel_id, token) = fixture(&app_pool).await;
    let mut seqs = Vec::new();
    let mut keys = std::collections::HashSet::new();
    for response in concurrent_sends(&app, &token, &[channel_id; 128], false).await {
        assert_eq!(response.status(), StatusCode::CREATED);
        let message = body(response).await;
        seqs.push(message["seq"].as_i64().unwrap());
        assert!(keys.insert(message["client_message_id"].as_str().unwrap().to_owned()));
    }
    seqs.sort_unstable();
    assert_eq!(seqs, (1..=128).collect::<Vec<_>>());
    let page = list(&app, &token, channel_id, "?after_seq=0&limit=200").await;
    assert_eq!(
        page["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["seq"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        seqs
    );
}

#[sqlx::test]
async fn failed_send_after_sequence_allocation_leaves_no_gap(pool: PgPool) {
    let (app, organization_id, _, channel_id, token) = fixture(&pool).await;
    sqlx::raw_sql(
        "CREATE FUNCTION fail_message_insert() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN IF NEW.body = 'fail-after-allocation' THEN RAISE EXCEPTION 'injected insert failure'; END IF; RETURN NEW; END $$; \
         CREATE TRIGGER fail_message_insert BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION fail_message_insert();",
    ).execute(&pool).await.unwrap();
    let key = Uuid::new_v4();
    for expected in [1, 2] {
        let response = send(
            &app,
            &token,
            channel_id,
            input(key, "fail-after-allocation"),
        )
        .await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(body(response).await, json!({"error": "internal error"}));
        let allocated: Option<i64> = sqlx::query_scalar("SELECT seq FROM channel_message_sequences WHERE organization_id = $1 AND channel_id = $2")
            .bind(organization_id).bind(channel_id).fetch_optional(&pool).await.unwrap();
        assert_eq!(allocated, if expected == 1 { None } else { Some(1) });
        assert_eq!(
            sent(&app, &token, channel_id, input(Uuid::new_v4(), "success")).await["seq"],
            expected
        );
    }
    assert_eq!(
        sent(&app, &token, channel_id, input(key, "retry after rollback")).await["seq"],
        3
    );
}

#[sqlx::test]
async fn message_pages_are_bounded_exclusive_ascending_and_directional(pool: PgPool) {
    let (app, organization_id, sender, channel_id, token) = fixture(&pool).await;
    assert_eq!(
        list(&app, &token, channel_id, "").await,
        json!({"messages": [], "has_more": false})
    );
    sqlx::query(
        "INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body) \
         SELECT $1, md5('id-' || n::text)::uuid, $2, n, $3, md5('client-' || n::text)::uuid, n::text \
         FROM generate_series(1, 205) n",
    ).bind(organization_id).bind(channel_id).bind(sender).execute(&pool).await.unwrap();
    for (query, expected, more) in [
        ("", (156..=205).collect::<Vec<_>>(), true),
        ("?limit=200", (6..=205).collect(), true),
        ("?after_seq=0&limit=200", (1..=200).collect(), true),
        ("?after_seq=200&limit=5", (201..=205).collect(), false),
        ("?after_seq=201&limit=2", vec![202, 203], true),
        ("?before_seq=5&limit=2", vec![3, 4], true),
        ("?before_seq=3&limit=2", vec![1, 2], false),
        ("?before_seq=1", vec![], false),
        ("?after_seq=205", vec![], false),
        ("?after_seq=9223372036854775807", vec![], false),
    ] {
        let page = list(&app, &token, channel_id, query).await;
        assert_eq!(
            page["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["seq"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            expected,
            "{query}"
        );
        assert_eq!(page["has_more"], more, "{query}");
    }
    for query in [
        "?after_seq=0&before_seq=2",
        "?after_seq=-1",
        "?before_seq=0",
        "?limit=0",
        "?limit=201",
        "?limit=65536",
        "?limit=bad",
        "?after_seq=9223372036854775808",
        "?after_seq=1&after_seq=2",
    ] {
        assert_error(
            request(
                &app,
                "GET",
                &format!("/api/v1/channels/{channel_id}/messages{query}"),
                &token,
                Value::Null,
            )
            .await,
            StatusCode::BAD_REQUEST,
        )
        .await;
    }
    assert_error(
        request(
            &app,
            "GET",
            "/api/v1/channels/not-a-uuid/messages",
            &token,
            Value::Null,
        )
        .await,
        StatusCode::BAD_REQUEST,
    )
    .await;
    assert_error(
        request(
            &app,
            "POST",
            "/api/v1/channels/not-a-uuid/messages",
            &token,
            input(Uuid::new_v4(), "hi"),
        )
        .await,
        StatusCode::BAD_REQUEST,
    )
    .await;
    let oversized = input(Uuid::new_v4(), &"x".repeat(32 * 1024 + 1));
    assert_error(
        send(&app, &token, channel_id, oversized).await,
        StatusCode::PAYLOAD_TOO_LARGE,
    )
    .await;
    for field in ["organization_id", "sender", "topic_id"] {
        let mut forged = input(Uuid::new_v4(), "forged");
        forged[field] = json!(Uuid::new_v4());
        assert_error(
            send(&app, &token, channel_id, forged).await,
            StatusCode::BAD_REQUEST,
        )
        .await;
    }
}

#[sqlx::test]
async fn messages_reject_cross_organization_foreign_keys(pool: PgPool) {
    let (_, organization_id, sender, channel_id, _) = fixture(&pool).await;
    let other_org = organization(&pool).await;
    let other_sender = Uuid::new_v4();
    member(&pool, other_org, other_sender).await;
    let other_channel = Uuid::new_v4();
    channel(&pool, other_org, other_channel, other_sender, false).await;
    for (channel, member) in [(other_channel, sender), (channel_id, other_sender)] {
        let error = sqlx::query("INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body) VALUES ($1, $2, $3, 1, $4, $5, 'forbidden')")
            .bind(organization_id).bind(Uuid::new_v4()).bind(channel).bind(member).bind(Uuid::new_v4()).execute(&pool).await.unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23503")
        );
    }
    let error = sqlx::query("INSERT INTO channel_message_sequences (organization_id, channel_id, seq) VALUES ($1, $2, 1)")
        .bind(organization_id).bind(other_channel).execute(&pool).await.unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("23503")
    );
}

#[sqlx::test]
async fn send_route_accepts_the_largest_valid_body_and_still_caps_the_request(pool: PgPool) {
    let (app, _, _, channel_id, token) = fixture(&pool).await;
    // 3999 control characters + 1 letter: 4000 scalar values, ~24 KB once JSON-escaped (> 16 KiB).
    let worst = format!("{}a", "\u{1}".repeat(3999));
    let stored = sent(&app, &token, channel_id, input(Uuid::new_v4(), &worst)).await;
    assert_eq!(stored["body"], worst);
    let response = send(
        &app,
        &token,
        channel_id,
        input(Uuid::new_v4(), &"x".repeat(40 * 1024)),
    )
    .await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}
