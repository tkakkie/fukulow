use super::*;
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use tokio::sync::Semaphore;
struct Gate {
    entered: Semaphore,
    release: Semaphore,
}
static GATES: LazyLock<Mutex<HashMap<Uuid, Arc<Gate>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
pub(crate) async fn pause(key: Uuid) {
    let gate = GATES.lock().unwrap().remove(&key);
    if let Some(gate) = gate {
        gate.entered.add_permits(1);
        gate.release.acquire().await.unwrap().forget();
    }
}

#[sqlx::test]
async fn send_grant_and_role_locks_order_removal_after_commit_and_deny_removal_first(pool: PgPool) {
    for case in ["private", "guest", "role"] {
        let (_, org, sender, channel, token) = fixture(&pool).await;
        if case == "private" {
            sqlx::query(
                "UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2",
            )
            .bind(org)
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
        }
        if case != "role" {
            sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)").bind(org).bind(channel).bind(sender).execute(&pool).await.unwrap();
        }
        if case == "guest" {
            sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(sender)
                .execute(&pool)
                .await
                .unwrap();
        }
        let state = AppState::for_test(pool.clone());
        let app = crate::app(state.clone());
        let key = Uuid::new_v4();
        let gate = Arc::new(Gate {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
        });
        GATES.lock().unwrap().insert(key, gate.clone());
        let send = {
            let app = app.clone();
            let token = token.clone();
            tokio::spawn(async move {
                request(
                    &app,
                    "POST",
                    &format!("/api/v1/channels/{channel}/messages"),
                    &token,
                    json!({"client_message_id":key,"body":"send first"}),
                )
                .await
            })
        };
        gate.entered.acquire().await.unwrap().forget();
        let revoke = {
            let pool = pool.clone();
            tokio::spawn(async move {
                if case == "role" {
                    sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
                        .bind(org)
                        .bind(sender)
                        .execute(&pool)
                        .await
                        .unwrap();
                } else {
                    sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(org).bind(channel).bind(sender).execute(&pool).await.unwrap();
                }
            })
        };
        tokio::time::timeout(Duration::from_secs(2),async {loop {
            let blocked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE 'DELETE FROM channel_members%' OR query LIKE 'UPDATE users SET role=%'))").fetch_one(&pool).await.unwrap();
            if blocked {break;} tokio::task::yield_now().await;
        }}).await.unwrap();
        assert!(!revoke.is_finished());
        gate.release.add_permits(1);
        assert_eq!(send.await.unwrap().status(), StatusCode::CREATED);
        revoke.await.unwrap();
        let r = request(
            &app,
            "POST",
            &format!("/api/v1/channels/{channel}/messages"),
            &token,
            json!({"client_message_id":key,"body":"send first"}),
        )
        .await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
        let before: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM messages WHERE organization_id=$1 AND channel_id=$2",
        )
        .bind(org)
        .bind(channel)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(before, 1);
        for input in [
            json!({"client_message_id":Uuid::new_v4(),"body":"ordinary"}),
            json!({"client_message_id":Uuid::new_v4(),"body":"Topic","topic_name":"Denied"}),
        ] {
            assert_eq!(
                request(
                    &app,
                    "POST",
                    &format!("/api/v1/channels/{channel}/messages"),
                    &token,
                    input
                )
                .await
                .status(),
                StatusCode::NOT_FOUND
            );
        }
        let counts:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM messages WHERE organization_id=$1 AND channel_id=$2),(SELECT count(*) FROM topics WHERE organization_id=$1 AND channel_id=$2),(SELECT seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2)").bind(org).bind(channel).fetch_one(&pool).await.unwrap();
        assert_eq!(counts, (1, 0, 1));
    }
}

#[sqlx::test]
async fn unread_mark_and_removal_serialize_without_recreating_revoked_positions(pool: PgPool) {
    for guest in [false, true] {
        let (_, org, sender, channel, token) = fixture(&pool).await;
        sqlx::query(
            "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
        )
        .bind(org)
        .bind(channel)
        .bind(sender)
        .execute(&pool)
        .await
        .unwrap();
        if guest {
            sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(sender)
                .execute(&pool)
                .await
                .unwrap();
        } else {
            sqlx::query(
                "UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2",
            )
            .bind(org)
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
        }
        let app = router(&pool);
        let topic_response = send(
            &app,
            &token,
            channel,
            json!({"client_message_id":Uuid::new_v4(),"body":"ordinary"}),
        )
        .await;
        assert_eq!(topic_response.status(), StatusCode::CREATED);
        let topic = body(topic_response).await;
        let key = Uuid::new_v4();
        let tr = request(
            &app,
            "POST",
            &format!("/api/v1/channels/{channel}/messages"),
            &token,
            json!({"client_message_id":key,"body":"Topic body","topic_name":"Topic"}),
        )
        .await;
        assert_eq!(tr.status(), StatusCode::CREATED);
        let tr = body(tr).await;
        let topic_id = tr["topic_id"].as_str().unwrap();
        let gate = Arc::new(Gate {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
        });
        GATES.lock().unwrap().insert(sender, gate.clone());
        let mark = {
            let app = app.clone();
            let token = token.clone();
            tokio::spawn(async move {
                request(
                    &app,
                    "PUT",
                    &format!("/api/v1/channels/{channel}/read"),
                    &token,
                    json!({"read_seq":99}),
                )
                .await
            })
        };
        gate.entered.acquire().await.unwrap().forget();
        let remove = {
            let pool = pool.clone();
            tokio::spawn(async move {
                sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(org).bind(channel).bind(sender).execute(&pool).await.unwrap();
            })
        };
        tokio::time::timeout(Duration::from_secs(2),async {loop {let wait:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'DELETE FROM channel_members%')").fetch_one(&pool).await.unwrap();if wait {break;}tokio::task::yield_now().await;}}).await.unwrap();
        gate.release.add_permits(1);
        assert_eq!(mark.await.unwrap().status(), StatusCode::OK);
        remove.await.unwrap();
        for suffix in ["read".into(), format!("topics/{topic_id}/read")] {
            assert_eq!(
                request(
                    &app,
                    "PUT",
                    &format!("/api/v1/channels/{channel}/{suffix}"),
                    &token,
                    json!({"read_seq":99})
                )
                .await
                .status(),
                StatusCode::NOT_FOUND
            );
        }
        let positions:i64=sqlx::query_scalar("SELECT (SELECT count(*) FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3)+(SELECT count(*) FROM topic_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3)").bind(org).bind(channel).bind(sender).fetch_one(&pool).await.unwrap();
        assert_eq!(positions, 0);
        assert_eq!(topic["seq"], 1);
        sqlx::query(
            "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
        )
        .bind(org)
        .bind(channel)
        .bind(sender)
        .execute(&pool)
        .await
        .unwrap();
        let positions:Vec<i64>=sqlx::query_scalar("SELECT initial_seq FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 UNION ALL SELECT read_seq FROM topic_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(org).bind(channel).bind(sender).fetch_all(&pool).await.unwrap();
        assert_eq!(positions, vec![2, 2]);
    }
}
