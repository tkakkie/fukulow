use super::*;
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;

struct HistoryGate {
    entered: Semaphore,
    release: Semaphore,
}
static HISTORY_GATES: LazyLock<Mutex<HashMap<Uuid, Arc<HistoryGate>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) async fn pause_history(channel: Uuid) {
    let gate = HISTORY_GATES.lock().unwrap().remove(&channel);
    if let Some(gate) = gate {
        gate.entered.add_permits(1);
        gate.release.acquire().await.unwrap().forget();
    }
}

pub(super) async fn captured_auth(pool: &PgPool, token: &str) -> Auth {
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
        .with_state(AppState::for_test(pool.clone()));
    assert_eq!(
        request(&app, "GET", "/api/v1/channels", token, Value::Null)
            .await
            .status(),
        StatusCode::OK
    );
    receiver.await.unwrap()
}

#[sqlx::test]
async fn deactivation_after_auth_is_organization_unavailable_for_history_and_send(pool: PgPool) {
    for reactivate in [false, true] {
        let (_, organization, sender, channel, token) = fixture(&pool).await;
        let history_auth = captured_auth(&pool, &token).await;
        let send_auth = captured_auth(&pool, &token).await;
        sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
            .bind(organization)
            .bind(sender)
            .execute(&pool)
            .await
            .unwrap();
        if reactivate {
            sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
                .bind(organization)
                .bind(sender)
                .execute(&pool)
                .await
                .unwrap();
        }
        let state = AppState::for_test(pool.clone());
        let response = list_messages(
            State(state.clone()),
            history_auth,
            Ok(Path((organization, channel))),
            Ok(Query(ListMessagesQuery {
                after_seq: None,
                before_seq: None,
                limit: None,
            })),
        )
        .await
        .unwrap_err()
        .into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body(response).await,
            json!({"error":"organization_unavailable"})
        );
        let response = send_message(
            State(state),
            send_auth,
            Ok(Path((organization, channel))),
            ApiJson(SendMessageRequest {
                topic_name: None,
                client_message_id: Uuid::new_v4(),
                body: "denied".into(),
            }),
        )
        .await
        .unwrap_err()
        .into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body(response).await,
            json!({"error":"organization_unavailable"})
        );
    }
}

#[sqlx::test]
async fn queued_send_rechecks_member_revision_and_private_grant_after_begin(pool: PgPool) {
    for denial in ["deactivate", "reactivate", "private_grant"] {
        let (_, organization, sender, channel, _) = fixture(&pool).await;
        sqlx::query("UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2")
            .bind(organization)
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
        )
        .bind(organization)
        .bind(channel)
        .bind(sender)
        .execute(&pool)
        .await
        .unwrap();
        let delivery = Delivery::default();
        let held = delivery
            .admission(&pool)
            .acquire(organization, channel, true)
            .await
            .unwrap();
        require_visible(&pool, organization, (sender, 0), channel)
            .await
            .unwrap();
        let key = Uuid::new_v4();
        let sending = persist(
            &pool,
            &delivery,
            organization,
            (sender, 0),
            channel,
            SendMessageRequest {
                topic_name: None,
                client_message_id: key,
                body: "must not commit".into(),
            },
            delivery
                .admission(&pool)
                .reserve_send(organization, channel)
                .unwrap(),
        );
        tokio::pin!(sending);
        // Poll the send into admission before changing the database; retain its future.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut sending)
                .await
                .is_err()
        );
        if denial == "private_grant" {
            sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                .bind(organization).bind(channel).bind(sender).execute(&pool).await.unwrap();
        } else {
            sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
                .bind(organization)
                .bind(sender)
                .execute(&pool)
                .await
                .unwrap();
            if denial == "reactivate" {
                sqlx::query(
                    "UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2",
                )
                .bind(organization)
                .bind(sender)
                .execute(&pool)
                .await
                .unwrap();
            }
        }
        drop(held);
        let response = sending.await.unwrap_err().into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(!response.headers().contains_key(header::RETRY_AFTER));
        assert_eq!(
            body(response).await,
            json!({"error": if denial == "private_grant" { "channel not found" } else { "organization_unavailable" }})
        );
        assert!(
            existing(&pool, organization, sender, key)
                .await
                .unwrap()
                .is_none()
        );
        let counters: i64 = sqlx::query_scalar("SELECT count(*) FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2")
            .bind(organization).bind(channel).fetch_one(&pool).await.unwrap();
        assert_eq!(counters, 0);
        assert_eq!(delivery.admission(&pool).queued_sends(), 0);
    }
}

#[sqlx::test]
async fn history_authorization_and_page_share_a_nonlocking_snapshot(pool: PgPool) {
    for denial in ["deactivate", "reactivate", "private_grant"] {
        let (_, organization, sender, channel, token) = fixture(&pool).await;
        sqlx::query("UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2")
            .bind(organization)
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
        )
        .bind(organization)
        .bind(channel)
        .bind(sender)
        .execute(&pool)
        .await
        .unwrap();
        let first = Uuid::new_v4();
        sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body) VALUES ($1,$2,$3,1,$4,$5,'before loss')")
            .bind(organization).bind(first).bind(channel).bind(sender).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
        let auth = captured_auth(&pool, &token).await;
        let next_auth = captured_auth(&pool, &token).await;
        let state = AppState::for_test(pool.clone());
        let gate = Arc::new(HistoryGate {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
        });
        HISTORY_GATES.lock().unwrap().insert(channel, gate.clone());
        let history = list_messages(
            State(state.clone()),
            auth,
            Ok(Path((organization, channel))),
            Ok(Query(ListMessagesQuery {
                after_seq: None,
                before_seq: None,
                limit: None,
            })),
        );
        tokio::pin!(history);
        tokio::select! {
            _ = &mut history => panic!("history did not pause after authorization"),
            permit = tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire()) => permit.unwrap().unwrap().forget(),
        }
        // Loss must commit while the page is paused: ordinary history holds no row lock.
        tokio::time::timeout(Duration::from_secs(5), async {
            if denial == "private_grant" {
                sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                    .bind(organization).bind(channel).bind(sender).execute(&pool).await.unwrap();
            } else {
                sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
                    .bind(organization).bind(sender).execute(&pool).await.unwrap();
                if denial == "reactivate" {
                    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
                        .bind(organization).bind(sender).execute(&pool).await.unwrap();
                }
            }
            sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body) VALUES ($1,$2,$3,2,$4,$5,'after loss')")
                .bind(organization).bind(Uuid::new_v4()).bind(channel).bind(sender).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
        }).await.unwrap();
        gate.release.add_permits(1);
        let response = history.await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let page = body(response).await;
        assert_eq!(page["messages"].as_array().unwrap().len(), 1);
        assert_eq!(page["messages"][0]["id"], first.to_string());
        assert_eq!(page["has_more"], false);
        // A new page after the commit must deny even the previously extracted Auth.
        let response = list_messages(
            State(state),
            next_auth,
            Ok(Path((organization, channel))),
            Ok(Query(ListMessagesQuery {
                after_seq: Some(0),
                before_seq: None,
                limit: None,
            })),
        )
        .await
        .unwrap_err()
        .into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body(response).await,
            json!({"error": if denial == "private_grant" { "channel not found" } else { "organization_unavailable" }})
        );
    }
}
