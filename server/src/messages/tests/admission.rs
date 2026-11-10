use super::*;
use std::time::Duration;

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
    )
    .await
    .unwrap();
    assert_eq!(message.seq, 1);
}
