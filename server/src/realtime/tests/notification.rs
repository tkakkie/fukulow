use super::*;

async fn publication_entered(gate: &messages::PublicationGate) {
    tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
}

#[sqlx::test]
async fn http_response_does_not_wait_for_notification_and_concurrent_sends_recover_order(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let mut socket = f.server.connect(&f.token).await;
    subscribe(&mut socket, f.channel, 0).await;
    ready(&mut socket, f.channel, 0).await;
    let key = Uuid::new_v4();
    let gate = messages::pause_publication(key);
    let first = tokio::time::timeout(
        Duration::from_secs(5),
        send(&f, &f.token, f.channel, key, "notification held"),
    )
    .await
    .unwrap();
    publication_entered(&gate).await;
    assert_eq!(first["seq"], 1);
    let history = messages::replay_page(&pool, f.organization, f.channel, 0, 1)
        .await
        .unwrap();
    assert_eq!(json!(history[0]), first);

    let mut sends = tokio::task::JoinSet::new();
    for _ in 0..16 {
        let app = f.app.clone();
        let token = f.token.clone();
        let channel = f.channel;
        sends.spawn(async move {
            request(
                &app,
                "POST",
                &format!("/api/v1/channels/{channel}/messages"),
                &token,
                json!({"client_message_id":Uuid::new_v4(),"body":"concurrent"}),
            )
            .await
        });
    }
    for seq in 1..=17 {
        assert_eq!(event(&mut socket).await["message"]["seq"], seq);
    }
    while let Some(result) = sends.join_next().await {
        assert_eq!(result.unwrap().status(), StatusCode::CREATED);
    }
    gate.release.add_permits(1);
    f.state.message_delivery.flush().await;
    silent(&mut socket).await;
}

#[sqlx::test]
async fn stopped_notification_after_response_closes_affected_sockets_and_reconnect_replays(
    pool: PgPool,
) {
    for abort in [true, false] {
        let f = fixture(&pool).await;
        let other_channel = channel(&pool, f.organization, f.member, false).await;
        let foreign = fixture(&pool).await;
        let mut live = f.server.connect(&f.token).await;
        subscribe(&mut live, f.channel, 0).await;
        ready(&mut live, f.channel, 0).await;
        let mut replaying = f.server.connect(&f.token).await;
        let replay_gate = pause(f.channel);
        subscribe(&mut replaying, f.channel, 0).await;
        entered(&replay_gate).await;
        let mut unrelated = f.server.connect(&f.token).await;
        subscribe(&mut unrelated, other_channel, 0).await;
        ready(&mut unrelated, other_channel, 0).await;
        let mut other_org = foreign.server.connect(&foreign.token).await;
        subscribe(&mut other_org, foreign.channel, 0).await;
        ready(&mut other_org, foreign.channel, 0).await;

        let key = Uuid::new_v4();
        let gate = messages::pause_publication(key);
        let committed = send(&f, &f.token, f.channel, key, "response before failure").await;
        publication_entered(&gate).await;
        if abort {
            gate.task.lock().unwrap().as_ref().unwrap().abort();
        } else {
            // Fail inside the notification future, rather than the HTTP worker.
            gate.release.close();
        }
        // No later publication is needed to expose this missing notification.
        closed(&mut live, 1011).await;
        closed(&mut replaying, 1011).await;
        f.state.message_delivery.flush().await;

        let mut reconnect = f.server.connect(&f.token).await;
        subscribe(&mut reconnect, f.channel, 0).await;
        assert_eq!(event(&mut reconnect).await["message"], committed);
        ready(&mut reconnect, f.channel, 1).await;
        let own = post(&f, other_channel).await;
        assert_eq!(event(&mut unrelated).await["message"], own);
        let own = post(&foreign, foreign.channel).await;
        assert_eq!(event(&mut other_org).await["message"], own);
    }
}

#[sqlx::test]
async fn notification_authorization_failure_closes_with_4008_and_reconnect_replays(pool: PgPool) {
    let f = fixture(&pool).await;
    let mut socket = f.server.connect(&f.token).await;
    subscribe(&mut socket, f.channel, 0).await;
    ready(&mut socket, f.channel, 0).await;
    let key = Uuid::new_v4();
    let gate = messages::pause_publication(key);
    let committed = send(&f, &f.token, f.channel, key, "authorization unavailable").await;
    publication_entered(&gate).await;
    sqlx::query("ALTER TABLE channels RENAME COLUMN visibility TO unavailable_visibility")
        .execute(&pool)
        .await
        .unwrap();
    gate.release.add_permits(1);
    closed(&mut socket, CLOSE_QUEUE_OVERFLOW).await;
    f.state.message_delivery.flush().await;
    sqlx::query("ALTER TABLE channels RENAME COLUMN unavailable_visibility TO visibility")
        .execute(&pool)
        .await
        .unwrap();
    let mut reconnect = f.server.connect(&f.token).await;
    subscribe(&mut reconnect, f.channel, 0).await;
    assert_eq!(event(&mut reconnect).await["message"], committed);
    ready(&mut reconnect, f.channel, 1).await;
}

#[sqlx::test]
async fn notification_rechecks_public_visibility_after_http_response(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_, nonmember) = member(&pool, f.organization).await;
    let mut socket = f.server.connect(&nonmember).await;
    subscribe(&mut socket, f.channel, 0).await;
    ready(&mut socket, f.channel, 0).await;
    let key = Uuid::new_v4();
    let gate = messages::pause_publication(key);
    let committed = send(&f, &f.token, f.channel, key, "public becomes private").await;
    publication_entered(&gate).await;
    sqlx::query(
        "UPDATE channels SET visibility = 'private' WHERE organization_id = $1 AND id = $2",
    )
    .bind(f.organization)
    .bind(f.channel)
    .execute(&pool)
    .await
    .unwrap();
    gate.release.add_permits(1);
    f.state.message_delivery.flush().await;
    // An authorized public Channel supplies a FIFO silence barrier after fan-out finishes.
    let barrier = channel(&pool, f.organization, f.member, false).await;
    subscribe(&mut socket, barrier, 0).await;
    ready(&mut socket, barrier, 0).await;
    subscribe(&mut socket, f.channel, 0).await;
    denied(&mut socket, f.channel).await;
    sqlx::query("UPDATE channels SET visibility = 'public' WHERE organization_id = $1 AND id = $2")
        .bind(f.organization)
        .bind(f.channel)
        .execute(&pool)
        .await
        .unwrap();
    subscribe(&mut socket, f.channel, 0).await;
    assert_eq!(event(&mut socket).await["message"], committed);
    ready(&mut socket, f.channel, 1).await;
    let next = post(&f, f.channel).await;
    assert_eq!(event(&mut socket).await["message"], next);
}
