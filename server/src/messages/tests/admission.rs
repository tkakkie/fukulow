use super::*;
use std::time::Duration;

fn assert_unavailable(response: &Response) {
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let retry: u64 = response.headers()[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=5).contains(&retry));
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
}

#[sqlx::test]
async fn send_queue_cap_returns_503_and_same_key_retry_is_idempotent(pool: PgPool) {
    let (_, organization, _, channel, token) = fixture(&pool).await;
    let state = AppState::for_test(pool.clone());
    let delivery = state.message_delivery.clone();
    let app = crate::app(state);
    let mut queued = Vec::new();
    for _ in 0..super::super::admission::CHANNEL_QUEUE_CAP {
        queued.push(
            delivery
                .admission(&pool)
                .reserve_send(organization, channel)
                .unwrap(),
        );
    }
    let key = Uuid::new_v4();
    let response = send(&app, &token, channel, input(key, "retry after saturation")).await;
    assert_unavailable(&response);
    assert_eq!(
        body(response).await,
        json!({"error": "send admission unavailable"})
    );
    assert!(
        list(&app, &token, channel, "").await["messages"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    drop(queued);
    let canonical = sent(&app, &token, channel, input(key, "retry after saturation")).await;
    assert_eq!(canonical["seq"], 1);
    assert_eq!(
        sent(&app, &token, channel, input(key, "retry after saturation")).await,
        canonical
    );
    // Downstream rejection (conflicting key) also releases the reservation.
    assert_error(
        send(&app, &token, channel, input(key, "different")).await,
        StatusCode::CONFLICT,
    )
    .await;
    assert_eq!(delivery.admission(&pool).queued_sends(), 0);
}

#[sqlx::test]
async fn saturated_send_queue_preserves_organization_and_private_channel_denials(pool: PgPool) {
    let organization_a = organization(&pool).await;
    let creator = Uuid::new_v4();
    let creator_token = member(&pool, organization_a, creator).await;
    let nonmember = member(&pool, organization_a, Uuid::new_v4()).await;
    let organization_b = organization(&pool).await;
    let outsider = member(&pool, organization_b, Uuid::new_v4()).await;
    let channel_id = Uuid::new_v4();
    channel(&pool, organization_a, channel_id, creator, true).await;
    let state = AppState::for_test(pool.clone());
    let delivery = state.message_delivery.clone();
    let app = crate::app(state);
    let admission = delivery.admission(&pool);
    let mut queued = Vec::new();
    for _ in 0..super::super::admission::CHANNEL_QUEUE_CAP {
        queued.push(admission.reserve_send(organization_a, channel_id).unwrap());
    }
    assert_unavailable(
        &send(
            &app,
            &creator_token,
            channel_id,
            input(Uuid::new_v4(), "full"),
        )
        .await,
    );
    for token in [&outsider, &nonmember] {
        assert_error(
            send(&app, token, channel_id, input(Uuid::new_v4(), "denied")).await,
            StatusCode::NOT_FOUND,
        )
        .await;
        assert_eq!(admission.queued_sends(), queued.len());
    }
    drop(queued);
    assert_eq!(admission.queued_sends(), 0);
    assert_eq!(
        sent(
            &app,
            &creator_token,
            channel_id,
            input(Uuid::new_v4(), "allowed")
        )
        .await["seq"],
        1
    );
}

#[sqlx::test]
async fn send_admission_expiry_returns_503_without_persisting_and_releases_slot(pool: PgPool) {
    let (_, organization, sender, channel, _) = fixture(&pool).await;
    let delivery = Delivery::default();
    let held = delivery
        .admission(&pool)
        .acquire(organization, channel, true)
        .await
        .unwrap();
    let key = Uuid::new_v4();
    let waiter = delivery
        .admission(&pool)
        .reserve_send(organization, channel)
        .unwrap();
    tokio::time::pause();
    let response = persist(
        &pool,
        &delivery,
        organization,
        sender,
        channel,
        SendMessageRequest {
            client_message_id: key,
            body: "expired".into(),
        },
        waiter,
    )
    .await
    .unwrap_err()
    .into_response();
    tokio::time::resume();
    assert_unavailable(&response);
    assert_eq!(delivery.admission(&pool).queued_sends(), 0);
    assert!(
        existing(&pool, organization, sender, key)
            .await
            .unwrap()
            .is_none()
    );
    drop(held);
}

#[sqlx::test]
async fn queued_send_gets_its_full_work_deadline_after_admission(pool: PgPool) {
    let (_, organization, sender, channel, _) = fixture(&pool).await;
    let delivery = Delivery::default();
    let held = delivery
        .admission(&pool)
        .acquire(organization, channel, true)
        .await
        .unwrap();
    let sending = persist(
        &pool,
        &delivery,
        organization,
        sender,
        channel,
        SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            body: "wait longer than the work deadline".into(),
        },
        delivery
            .admission(&pool)
            .reserve_send(organization, channel)
            .unwrap(),
    );
    tokio::pin!(sending);
    tokio::time::pause();
    assert!(
        tokio::time::timeout(
            super::super::admission::WORK_TIMEOUT + Duration::from_secs(1),
            &mut sending,
        )
        .await
        .is_err(),
        "admission must not consume the database work deadline"
    );
    drop(held);
    tokio::time::resume();
    assert_eq!(sending.await.unwrap().seq, 1);
    assert_eq!(delivery.admission(&pool).queued_sends(), 0);
}

#[sqlx::test]
async fn send_deadline_includes_pool_acquisition_and_releases_admission(pool: PgPool) {
    let (_, organization, sender, channel, _) = fixture(&pool).await;
    let app_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let first = app_pool.acquire().await.unwrap();
    let second = app_pool.acquire().await.unwrap();
    let delivery = Delivery::default();
    let task = {
        let pool = app_pool.clone();
        let delivery = delivery.clone();
        tokio::spawn(async move {
            persist(
                &pool,
                &delivery,
                organization,
                sender,
                channel,
                SendMessageRequest {
                    client_message_id: Uuid::new_v4(),
                    body: "pool wait".into(),
                },
                delivery
                    .admission(&pool)
                    .reserve_send(organization, channel)
                    .unwrap(),
            )
            .await
        })
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        while delivery.admission(&app_pool).available_permits() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tokio::time::pause();
    tokio::time::advance(super::super::admission::WORK_TIMEOUT).await;
    tokio::time::resume();
    assert!(
        matches!(task.await.unwrap(), Err(MessageError::Database(sqlx::Error::Io(error))) if error.kind() == std::io::ErrorKind::TimedOut)
    );
    assert_eq!(delivery.admission(&app_pool).available_permits(), 1);
    assert_eq!(delivery.admission(&app_pool).queued_sends(), 0);
    drop((first, second));
    let message = persist(
        &app_pool,
        &delivery,
        organization,
        sender,
        channel,
        SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            body: "after timeout".into(),
        },
        delivery
            .admission(&app_pool)
            .reserve_send(organization, channel)
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(message.seq, 1);
}
