use super::*;

async fn reply_send(f: &Fixture, token: &str, channel: Uuid, key: Uuid, parent: &Value) -> Value {
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/channels/{channel}/messages"),
        token,
        json!({"client_message_id":key,"body":"Reply payload","reply_to":parent["id"]}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    serde_json::from_slice(&to_bytes(response.into_body(), 32 * 1024).await.unwrap()).unwrap()
}

#[sqlx::test]
async fn reply_ack_history_live_replay_shared_gap_and_unloaded_parent_payloads_match(pool: PgPool) {
    let f = fixture(&pool).await;
    let root = topics::topic_send(&f, &f.token, f.channel, Uuid::new_v4()).await;
    let mut live = f.server.connect(&f.token).await;
    subscribe(&mut live, f.channel, 1).await;
    ready(&mut live, f.channel, 1).await;
    let key = Uuid::new_v4();
    let gate = messages::pause_publication(key);
    let first = reply_send(&f, &f.token, f.channel, key, &root).await;
    gate.entered.acquire().await.unwrap().forget();
    let second = reply_send(&f, &f.token, f.channel, Uuid::new_v4(), &first).await;
    assert_eq!(event(&mut live).await["message"], first);
    assert_eq!(event(&mut live).await["message"], second);
    assert_eq!(second["reply_to"], first["id"]);
    assert_eq!(second["reply_root_id"], root["id"]);
    assert_eq!(second["topic_id"], root["topic_id"]);
    gate.release.add_permits(1);
    f.state.message_delivery.flush().await;
    for suffix in [
        "messages?after_seq=0".to_owned(),
        format!("messages/{}/chain", second["id"].as_str().unwrap()),
        format!(
            "topics/{}/messages?after_seq=0",
            root["topic_id"].as_str().unwrap()
        ),
    ] {
        let response = request(
            &f.app,
            "GET",
            &format!("/api/v1/channels/{}/{suffix}", f.channel),
            &f.token,
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let p: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 32 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(p["messages"], json!([root, first, second]));
    }
    assert_eq!(reply_send(&f, &f.token, f.channel, key, &root).await, first);
    f.state.message_delivery.flush().await;
    silent(&mut live).await;
    let mut reconnect = f.server.connect(&f.token).await;
    subscribe(&mut reconnect, f.channel, 1).await;
    assert_eq!(event(&mut reconnect).await["message"], first);
    assert_eq!(event(&mut reconnect).await["message"], second);
    ready(&mut reconnect, f.channel, 3).await;
    // This subscriber has loaded only the root; the live child identifies its chain without fetching its parent.
    let mut unloaded = f.server.connect(&f.token).await;
    subscribe(&mut unloaded, f.channel, 3).await;
    ready(&mut unloaded, f.channel, 3).await;
    let third = reply_send(&f, &f.token, f.channel, Uuid::new_v4(), &second).await;
    let payload = event(&mut unloaded).await["message"].clone();
    assert_eq!(payload, third);
    assert_eq!(payload["reply_root_id"], root["id"]);
}

#[sqlx::test]
async fn reply_ambiguous_commit_reconnect_recovers_without_a_later_send(pool: PgPool) {
    let f = fixture(&pool).await;
    let root = topics::topic_send(&f, &f.token, f.channel, Uuid::new_v4()).await;
    let mut live = f.server.connect(&f.token).await;
    subscribe(&mut live, f.channel, 1).await;
    ready(&mut live, f.channel, 1).await;
    let key = Uuid::new_v4();
    let pending = messages::ambiguous_commit(key);
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/channels/{}/messages", f.channel),
        &f.token,
        json!({"client_message_id":key,"body":"Reply payload","reply_to":root["id"]}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let tx = pending.await.unwrap();
    closed(&mut live, 1011).await;
    let mut reconnect = f.server.connect(&f.token).await;
    subscribe(&mut reconnect, f.channel, 1).await;
    tx.commit().await.unwrap();
    let canonical = reply_send(&f, &f.token, f.channel, key, &root).await;
    assert_eq!(event(&mut reconnect).await["message"], canonical);
    ready(&mut reconnect, f.channel, 2).await;
    assert_eq!(canonical["reply_root_id"], root["id"]);
    assert_eq!(canonical["seq"], 2);
    f.state.message_delivery.flush().await;
    silent(&mut reconnect).await;
}

#[sqlx::test]
async fn reply_live_replay_cross_organization_and_private_nonmember_denials_have_positive_controls(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    let (_, nonmember) = member(&pool, f.organization).await;
    let other = organization(&pool).await;
    let (_, foreign) = member(&pool, other).await;
    let root = topics::topic_send(&f, &f.token, private, Uuid::new_v4()).await;
    let mut owner = f.server.connect(&f.token).await;
    subscribe(&mut owner, private, 1).await;
    ready(&mut owner, private, 1).await;
    let mut denied_sockets = Vec::new();
    for token in [&nonmember, &foreign] {
        let mut socket = f.server.connect(token).await;
        subscribe(&mut socket, private, 0).await;
        denied(&mut socket, private).await;
        denied_sockets.push(socket);
    }
    let secret = reply_send(&f, &f.token, private, Uuid::new_v4(), &root).await;
    assert_eq!(event(&mut owner).await["message"], secret);
    f.state.message_delivery.flush().await;
    for socket in &mut denied_sockets {
        silent(socket).await;
        subscribe(socket, private, 0).await;
        denied(socket, private).await;
    }
    let mut replay = f.server.connect(&f.token).await;
    subscribe(&mut replay, private, 0).await;
    assert_eq!(event(&mut replay).await["message"], root);
    assert_eq!(event(&mut replay).await["message"], secret);
    ready(&mut replay, private, 2).await;
}

#[sqlx::test]
async fn reply_live_replay_member_revision_and_removed_grant_denials_have_positive_controls(
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
        let root = topics::topic_send(&f, &f.token, target, Uuid::new_v4()).await;
        let first = reply_send(&f, &f.token, target, Uuid::new_v4(), &root).await;
        let mut live = f.server.connect(&token).await;
        subscribe(&mut live, target, 2).await;
        ready(&mut live, target, 2).await;
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
        let second = reply_send(&f, &f.token, target, Uuid::new_v4(), &first).await;
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
        assert_eq!(event(&mut control).await["message"], root);
        assert_eq!(event(&mut control).await["message"], first);
        assert_eq!(event(&mut control).await["message"], second);
        ready(&mut control, target, 3).await;
    }
}
