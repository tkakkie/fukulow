use super::*;
use std::time::Duration;

#[sqlx::test]
async fn send_completes_while_topic_projection_query_is_paused(pool: PgPool) {
    let (app, _, _, channel, token) = fixture(&pool).await;
    sent(
        &app,
        &token,
        channel,
        topic_input(Uuid::new_v4(), "Existing"),
    )
    .await;
    // A read-only view gate pauses the real aggregate without blocking the FK
    // checks used by a concurrent send against the underlying Topics table.
    sqlx::raw_sql(
        "ALTER TABLE topics RENAME TO topics_storage; CREATE VIEW topics AS \
        WITH gate AS MATERIALIZED (SELECT pg_advisory_xact_lock_shared(202137)) \
        SELECT t.* FROM topics_storage t CROSS JOIN gate",
    )
    .execute(&pool)
    .await
    .unwrap();
    let mut held = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(202137)")
        .execute(&mut *held)
        .await
        .unwrap();
    let read = {
        let app = app.clone();
        let token = token.clone();
        tokio::spawn(async move { get(&app, &token, channel, "timeline").await })
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND locktype='advisory' AND objid=202137 AND NOT granted)")
                .fetch_one(&pool).await.unwrap();
            if waiting { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    let message = tokio::time::timeout(
        Duration::from_secs(2),
        sent(
            &app,
            &token,
            channel,
            input(Uuid::new_v4(), "concurrent plain"),
        ),
    )
    .await
    .expect("send must not wait behind the projection barrier");
    assert_eq!(message["seq"], 2);
    assert!(!read.is_finished());
    held.commit().await.unwrap();
    let page = read.await.unwrap();
    assert_eq!(page["as_of_seq"], 1);
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
}

#[sqlx::test]
async fn future_projection_watermark_is_rejected_before_query(pool: PgPool) {
    let (app, _, _, channel, token) = fixture(&pool).await;
    let mut held = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE topics IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *held)
        .await
        .unwrap();
    for suffix in ["timeline?as_of_seq=1", "topics?as_of_seq=1"] {
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            request(
                &app,
                "GET",
                &format!("/api/v1/channels/{channel}/{suffix}"),
                &token,
                Value::Null,
            ),
        )
        .await
        .expect("future W must not start the blocked aggregate");
        assert_error(response, StatusCode::BAD_REQUEST).await;
    }
    held.rollback().await.unwrap();
}

#[sqlx::test]
async fn topic_read_admission_rejection_returns_retry_after(pool: PgPool) {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let (_, org, _, channel, token) = fixture(&pool).await;
    let state = AppState::for_test(pool.clone()).await;
    let delivery = state.message_delivery.clone();
    let app = crate::app(state);
    let message = sent(
        &app,
        &token,
        channel,
        topic_input(Uuid::new_v4(), "Existing"),
    )
    .await;
    let topic = message["topic_id"].as_str().unwrap();
    let mut permits = Vec::new();
    for _ in 0..4 {
        permits.push(
            delivery
                .admission(&pool)
                .acquire(org, channel, false)
                .await
                .unwrap(),
        );
    }
    for suffix in [
        "timeline".into(),
        "topics".into(),
        format!("topics/{topic}"),
        format!("topics/{topic}/messages"),
    ] {
        let response = request(
            &app,
            "GET",
            &format!("/api/v1/channels/{channel}/{suffix}"),
            &token,
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert!(
            (1..=5).contains(
                &response.headers()[header::RETRY_AFTER]
                    .to_str()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap()
            )
        );
        assert_eq!(
            body(response).await,
            json!({"error":"projection admission unavailable"})
        );
    }
    drop(permits);
    assert_eq!(get(&app, &token, channel, "timeline").await["as_of_seq"], 1);
}
