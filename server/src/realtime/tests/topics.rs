use super::*;

async fn topic_send(f: &Fixture, token: &str, channel: Uuid, key: Uuid) -> Value {
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/channels/{channel}/messages"),
        token,
        json!({"client_message_id":key,"body":"Topic payload","topic_name":"Release"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    serde_json::from_slice(&to_bytes(response.into_body(), 32 * 1024).await.unwrap()).unwrap()
}

#[sqlx::test]
async fn topic_ack_history_live_reconnect_and_shared_gap_payloads_are_identical(pool: PgPool) {
    let f = fixture(&pool).await;
    let mut live = f.server.connect(&f.token).await;
    subscribe(&mut live, f.channel, 0).await;
    ready(&mut live, f.channel, 0).await;
    let first_key = Uuid::new_v4();
    let gate = messages::pause_publication(first_key);
    let first = topic_send(&f, &f.token, f.channel, first_key).await;
    gate.entered.acquire().await.unwrap().forget();
    let second = topic_send(&f, &f.token, f.channel, Uuid::new_v4()).await;
    // Second publication recovers the committed prefix through shared fan-out.
    assert_eq!(event(&mut live).await["message"], first);
    assert_eq!(event(&mut live).await["message"], second);
    assert!(first["topic_id"].is_string());
    assert_eq!(first["topic_id"], second["topic_id"]);
    gate.release.add_permits(1);
    f.state.message_delivery.flush().await;
    let history = request(
        &f.app,
        "GET",
        &format!("/api/v1/channels/{}/messages?after_seq=0", f.channel),
        &f.token,
        Value::Null,
    )
    .await;
    let history: Value =
        serde_json::from_slice(&to_bytes(history.into_body(), 32 * 1024).await.unwrap()).unwrap();
    assert_eq!(history["messages"], json!([first, second]));
    assert_eq!(topic_send(&f, &f.token, f.channel, first_key).await, first);
    f.state.message_delivery.flush().await;
    silent(&mut live).await;
    drop(live);
    let mut reconnect = f.server.connect(&f.token).await;
    subscribe(&mut reconnect, f.channel, 1).await;
    assert_eq!(event(&mut reconnect).await["message"], second);
    ready(&mut reconnect, f.channel, 2).await;
    let third = topic_send(&f, &f.token, f.channel, Uuid::new_v4()).await;
    assert_eq!(event(&mut reconnect).await["message"], third);
}

#[sqlx::test]
async fn topic_live_replay_cross_organization_and_private_nonmember_denials_have_positive_controls(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    let (_, nonmember) = member(&pool, f.organization).await;
    let other = organization(&pool).await;
    let (_, foreign) = member(&pool, other).await;
    let mut owner = f.server.connect(&f.token).await;
    subscribe(&mut owner, private, 0).await;
    ready(&mut owner, private, 0).await;
    let mut denied_sockets = Vec::new();
    for token in [&nonmember, &foreign] {
        let mut socket = f.server.connect(token).await;
        subscribe(&mut socket, private, 0).await;
        denied(&mut socket, private).await;
        denied_sockets.push(socket);
    }
    let secret = topic_send(&f, &f.token, private, Uuid::new_v4()).await;
    assert_eq!(event(&mut owner).await["message"], secret);
    f.state.message_delivery.flush().await;
    for socket in &mut denied_sockets {
        silent(socket).await;
        subscribe(socket, private, 0).await;
        denied(socket, private).await;
    }
    let mut replay = f.server.connect(&f.token).await;
    subscribe(&mut replay, private, 0).await;
    assert_eq!(event(&mut replay).await["message"], secret);
    ready(&mut replay, private, 1).await;
}

#[sqlx::test]
async fn topic_live_replay_member_revision_and_removed_grant_denials_have_positive_controls(
    pool: PgPool,
) {
    for loss in ["deactivated", "stale", "grant"] {
        let f = fixture(&pool).await;
        let target = if loss == "grant" {
            channel(&pool, f.organization, f.member, true).await
        } else {
            f.channel
        };
        let (viewer, token) = member(&pool, f.organization).await;
        if loss == "grant" {
            sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)").bind(f.organization).bind(target).bind(viewer).execute(&pool).await.unwrap();
        }
        let first = topic_send(&f, &f.token, target, Uuid::new_v4()).await;
        let mut live = f.server.connect(&token).await;
        subscribe(&mut live, target, 1).await;
        ready(&mut live, target, 1).await;
        let mut replay = f.server.connect(&token).await;
        let gate = pause(target);
        subscribe(&mut replay, target, 0).await;
        entered(&gate).await;
        if loss == "grant" {
            sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(f.organization).bind(target).bind(viewer).execute(&pool).await.unwrap();
        } else {
            sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
                .bind(f.organization)
                .bind(viewer)
                .execute(&pool)
                .await
                .unwrap();
            if loss == "stale" {
                sqlx::query(
                    "UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2",
                )
                .bind(f.organization)
                .bind(viewer)
                .execute(&pool)
                .await
                .unwrap();
            }
        }
        gate.release.add_permits(1);
        if loss == "grant" {
            denied(&mut replay, target).await;
        } else {
            closed(&mut replay, CLOSE_ORGANIZATION_UNAVAILABLE).await;
        }
        let second = topic_send(&f, &f.token, target, Uuid::new_v4()).await;
        f.state.message_delivery.flush().await;
        silent(&mut live).await;
        subscribe(&mut live, target, 0).await;
        if loss == "grant" {
            denied(&mut live, target).await;
        } else {
            closed(&mut live, CLOSE_ORGANIZATION_UNAVAILABLE).await;
        }
        let mut control = f.server.connect(&f.token).await;
        subscribe(&mut control, target, 0).await;
        assert_eq!(event(&mut control).await["message"], first);
        assert_eq!(event(&mut control).await["message"], second);
        ready(&mut control, target, 2).await;
    }
}
