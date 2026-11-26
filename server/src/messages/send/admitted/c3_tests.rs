use std::{sync::Arc, time::Duration};

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Path, State},
    http::{Request, StatusCode, header},
    response::Response,
    routing::post,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::{sync::mpsc::error::TryRecvError, time::timeout};
use tower::ServiceExt;
use uuid::Uuid;

use super::RECEIPT_MISS;
use crate::{AppState, messages::MessageError};

const DEADLINE: Duration = Duration::from_secs(5);

struct Fixture {
    org: Uuid,
    sender: Uuid,
    channel: Uuid,
    token: String,
}

impl Fixture {
    async fn seed(admin: &PgPool) -> Self {
        let org = Uuid::new_v4();
        let sender = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let account = Uuid::new_v4();
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());

        sqlx::query(
            "WITH org AS (
                INSERT INTO organizations (organization_id, name) VALUES ($1, 'Organization')
            ), account AS (
                INSERT INTO accounts (id, email, password_hash) VALUES ($2, $3, 'unused')
            ), member AS (
                INSERT INTO users (organization_id, id, account_id, name, role)
                VALUES ($1, $4, $2, 'Member', 'member')
            ), channel AS (
                INSERT INTO channels (organization_id, id, name, visibility)
                VALUES ($1, $5, 'Channel', 'public')
            )
            INSERT INTO account_sessions (account_id, token_hash) VALUES ($2, $6)",
        )
        .bind(org)
        .bind(account)
        .bind(format!("{account}@example.com"))
        .bind(sender)
        .bind(channel)
        .bind(Sha256::digest(token.as_bytes()).to_vec())
        .execute(admin)
        .await
        .unwrap();
        Self {
            org,
            sender,
            channel,
            token,
        }
    }

    async fn send(&self, app: &Router, input: &Value) -> Response {
        app.clone()
            .oneshot(
                Request::post(format!(
                    "/api/v1/orgs/{}/channels/{}/messages",
                    self.org, self.channel
                ))
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
                .body(Body::from(input.to_string()))
                .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn log(&self, admin: &PgPool) -> Vec<(i64, String, Uuid, Uuid)> {
        sqlx::query_as(
            "SELECT event_seq, kind, message_id, client_message_id FROM channel_log
             WHERE organization_id=$1 AND channel_id=$2 ORDER BY event_seq",
        )
        .bind(self.org)
        .bind(self.channel)
        .fetch_all(admin)
        .await
        .unwrap()
    }

    async fn snapshot(&self, admin: &PgPool) -> Value {
        sqlx::query_scalar(
            "SELECT jsonb_build_object(
                'messages', (SELECT jsonb_agg(m ORDER BY id) FROM messages m WHERE organization_id=$1),
                'log', (SELECT jsonb_agg(l ORDER BY event_seq) FROM channel_log l WHERE organization_id=$1),
                'sequence', (SELECT to_jsonb(s) FROM channel_message_sequences s WHERE organization_id=$1),
                'topics', (SELECT jsonb_agg(t ORDER BY id) FROM topics t WHERE organization_id=$1),
                'unread', (SELECT jsonb_agg(a ORDER BY scope_id, member_id) FROM message_append_counts a WHERE organization_id=$1),
                'unread_corrections', (SELECT jsonb_agg(c ORDER BY scope_id, seq, message_id) FROM message_count_corrections c WHERE organization_id=$1),
                'search', (SELECT jsonb_agg(s ORDER BY term, message_id) FROM message_search_terms s WHERE organization_id=$1)
            )",
        )
        .bind(self.org)
        .fetch_one(admin)
        .await
        .unwrap()
    }
}

fn send_router(state: AppState) -> Router {
    Router::new()
        .route(
            "/api/v1/orgs/{org}/channels/{id}/messages",
            post(
                async |state: State<AppState>, auth, path: Result<Path<(Uuid, Uuid)>, _>, input| {
                    match super::super::send_message(state, auth, path, input).await {
                        Ok(response) => Ok(response),
                        Err(error) => Err((
                            axum::Extension(Arc::new(error)),
                            StatusCode::INTERNAL_SERVER_ERROR,
                        )),
                    }
                },
            ),
        )
        .with_state(state)
}

fn input(key: Uuid, topic: &str) -> Value {
    json!({"client_message_id": key, "body": "searchable words", "topic_name": topic})
}

async fn receipt(response: Response) -> Value {
    assert_eq!(response.status(), StatusCode::CREATED);
    serde_json::from_slice(&to_bytes(response.into_body(), 256 * 1024).await.unwrap()).unwrap()
}

#[fukulow_test::test]
async fn c3_conflict_after_receipt_miss_uses_winner_without_sequence_gap(admin: PgPool) {
    let fixture = Fixture::seed(&admin).await;
    let a = send_router(AppState::for_test(admin.clone()).await);
    // The harness keys runtime pools by admin-pool identity. A fresh admin pool
    // gives B a separate runtime pool with the same role and database.
    let other_admin = PgPoolOptions::new()
        .max_connections(admin.options().get_max_connections())
        .connect_with(admin.connect_options().as_ref().clone())
        .await
        .unwrap();
    let b = send_router(AppState::for_test(other_admin.clone()).await);
    other_admin.close().await;

    let key = Uuid::new_v4();
    let request = input(key, "Conflict");
    let gate = RECEIPT_MISS.register(key);
    let (loser, winner) = tokio::join!(fixture.send(&a, &request), async {
        gate.entered().await;
        let winner = timeout(DEADLINE, fixture.send(&b, &request)).await;
        gate.release();
        receipt(winner.expect("B did not commit while A was paused")).await
    });

    assert_eq!(
        gate.hook_state.get(),
        Some(&true),
        "A's fused Message and Create statement must run and return zero rows"
    );
    assert_eq!(receipt(loser).await, winner);
    let log = fixture.log(&admin).await;
    let winner_id = serde_json::from_value(winner["id"].clone()).unwrap();
    assert_eq!(log, [(1, "create".into(), winner_id, key)]);

    let next = receipt(fixture.send(&b, &input(Uuid::new_v4(), "Conflict")).await).await;
    assert_eq!(next["created_seq"], log[0].0 + 1);
    assert_eq!(fixture.log(&admin).await[1].0, log[0].0 + 1);
}

async fn assert_send_failure_rolls_back(
    admin: PgPool,
    table: &str,
    trigger_body: &str,
    code: &str,
    message: &str,
) {
    let fixture = Fixture::seed(&admin).await;
    let state = AppState::for_test(admin.clone()).await;
    let app = send_router(state.clone());
    let before = receipt(fixture.send(&app, &input(Uuid::new_v4(), "Before")).await).await;
    let last_seq = before["created_seq"].as_i64().unwrap();
    timeout(DEADLINE, state.message_delivery.drained())
        .await
        .unwrap();
    let mut queue = state
        .message_delivery
        .queue(fixture.org, (fixture.sender, 0), 8);
    queue.subscribe(fixture.channel);
    let before = fixture.snapshot(&admin).await;
    assert!(before["unread"].is_array() && before["search"].is_array());

    sqlx::raw_sql(&format!(
        "CREATE FUNCTION reject_c3_send() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            {trigger_body}
            RAISE EXCEPTION USING ERRCODE = '{code}', MESSAGE = '{message}';
         END $$;
         CREATE TRIGGER reject_c3_send BEFORE INSERT ON {table}
         FOR EACH ROW EXECUTE FUNCTION reject_c3_send();",
    ))
    .execute(&admin)
    .await
    .unwrap();

    let key = Uuid::new_v4();
    let request = input(key, "Retry");
    let response = fixture.send(&app, &request).await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let Some(MessageError::Database(error)) = response
        .extensions()
        .get::<Arc<MessageError>>()
        .map(Arc::as_ref)
    else {
        panic!("expected the Send handler to return a database error");
    };
    let error = error.as_database_error().unwrap();
    assert_eq!(error.message(), message);
    assert_eq!(error.code().as_deref(), Some(code));

    assert_eq!(fixture.snapshot(&admin).await, before);
    timeout(DEADLINE, state.message_delivery.drained())
        .await
        .unwrap();
    assert!(matches!(queue.events.try_recv(), Err(TryRecvError::Empty)));
    assert!(!queue.notification_failed.is_failed());

    sqlx::raw_sql(&format!(
        "DROP TRIGGER reject_c3_send ON {table}; DROP FUNCTION reject_c3_send();"
    ))
    .execute(&admin)
    .await
    .unwrap();
    let retry = receipt(fixture.send(&app, &request).await).await;
    assert_eq!(retry["created_seq"], last_seq + 1);
    let log = fixture.log(&admin).await;
    let retry_id = serde_json::from_value(retry["id"].clone()).unwrap();
    assert_eq!(log.len(), 2);
    assert_eq!(log[1], (last_seq + 1, "create".into(), retry_id, key));
    let event = timeout(DEADLINE, queue.events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.seq, last_seq + 1);
    assert_eq!(event.message().id, retry_id);
}

#[fukulow_test::test]
async fn c3_log_failure_rolls_back_send_without_publishing(admin: PgPool) {
    assert_send_failure_rolls_back(
        admin,
        "channel_log",
        "IF EXISTS (SELECT FROM message_search_terms
                    WHERE organization_id=NEW.organization_id AND message_id=NEW.message_id) THEN
             RAISE EXCEPTION 'search index ran before Create';
         END IF;",
        "P6211",
        "injected C3 Create failure",
    )
    .await;
}

#[fukulow_test::test]
async fn c3_search_failure_rolls_back_send_without_publishing(admin: PgPool) {
    assert_send_failure_rolls_back(
        admin,
        "message_search_terms",
        "IF NOT EXISTS (
             SELECT FROM channel_log
             WHERE organization_id=NEW.organization_id AND channel_id=NEW.channel_id
               AND message_id=NEW.message_id AND kind='create'
         ) THEN
             RAISE EXCEPTION 'Create missing before search indexing';
         END IF;",
        "P6212",
        "injected C3 search-index failure",
    )
    .await;
}
