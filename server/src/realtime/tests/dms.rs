use super::*;

async fn open(f: &Fixture, peer: Uuid) -> Uuid {
    let r = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{}/dms", f.organization),
        &f.token,
        json!({"member_id":peer}),
    )
    .await;
    assert_eq!(r.status(), StatusCode::CREATED);
    Uuid::parse_str(body(r).await["id"].as_str().unwrap()).unwrap()
}

#[fukulow_test::test]
async fn dm_participant_and_guest_replay_live_and_every_nonparticipant_role_is_denied(
    pool: PgPool,
) {
    for peer_role in ["member", "guest"] {
        let f = fixture(&pool).await;
        let (peer, peer_token) = member(&pool, f.organization).await;
        sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
            .bind(f.organization)
            .bind(peer)
            .bind(peer_role)
            .execute(&pool)
            .await
            .unwrap();
        let c = open(&f, peer).await;
        let first = send(&f, &f.token, c, Uuid::new_v4(), "first").await;
        let mut a = f.server.connect(&f.token).await;
        let mut b = f.server.connect(&peer_token).await;
        for socket in [&mut a, &mut b] {
            subscribe(socket, c, 0).await;
            assert_eq!(event(socket).await["message"], first);
            ready(socket, c, 1).await;
        }
        for role in ["owner", "admin", "member", "guest"] {
            let (other, token) = member(&pool, f.organization).await;
            sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
                .bind(f.organization)
                .bind(other)
                .bind(role)
                .execute(&pool)
                .await
                .unwrap();
            let mut denied_socket = f.server.connect(&token).await;
            subscribe(&mut denied_socket, c, 0).await;
            denied(&mut denied_socket, c).await;
            let live = send(&f, &peer_token, c, Uuid::new_v4(), "live Guest or Member").await;
            assert!(live["topic_id"].is_null());
            assert_eq!(event(&mut a).await["message"], live);
            assert_eq!(event(&mut b).await["message"], live);
            silent(&mut denied_socket).await;
        }
        drop(a);
        drop(b);
        let mut again = f.server.connect(&peer_token).await;
        subscribe(&mut again, c, 0).await;
        for _ in 0..5 {
            assert_eq!(event(&mut again).await["type"], "message");
        }
        ready(&mut again, c, 5).await;
    }
}

#[fukulow_test::test]
async fn dm_deactivation_closes_idle_and_replaying_sockets_and_reactivation_does_not_restore_access(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let (peer, peer_token) = member(&pool, f.organization).await;
    sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(peer)
        .execute(&pool)
        .await
        .unwrap();
    let c = open(&f, peer).await;
    send(&f, &f.token, c, Uuid::new_v4(), "history").await;
    let mut idle = f.server.connect(&peer_token).await;
    let mut replay = f.server.connect(&peer_token).await;
    let gate = pause(c);
    subscribe(&mut replay, c, 0).await;
    entered(&gate).await;
    let (owner, owner_token) = member(&pool, f.organization).await;
    sqlx::query("UPDATE users SET role='owner' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(owner)
        .execute(&pool)
        .await
        .unwrap();
    let r = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{}/members/{peer}/deactivate", f.organization),
        &owner_token,
        Value::Null,
    )
    .await;
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    closed(&mut idle, CLOSE_ORGANIZATION_UNAVAILABLE).await;
    closed(&mut replay, CLOSE_ORGANIZATION_UNAVAILABLE).await;
    gate.release.add_permits(1);
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(peer)
        .execute(&pool)
        .await
        .unwrap();
    let mut fresh = f.server.connect(&peer_token).await;
    subscribe(&mut fresh, c, 0).await;
    denied(&mut fresh, c).await;
    silent(&mut fresh).await;
    let r = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{}/dms", f.organization),
        &f.token,
        json!({"member_id":peer,"renew":true}),
    )
    .await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(body(r).await["id"], c.to_string());
    subscribe(&mut fresh, c, 0).await;
    assert_eq!(event(&mut fresh).await["type"], "message");
    ready(&mut fresh, c, 1).await;
    let live = send(&f, &peer_token, c, Uuid::new_v4(), "renewed Guest").await;
    assert_eq!(event(&mut fresh).await["message"], live);
}

#[fukulow_test::test]
async fn dm_two_client_discovery_without_notices_sees_delayed_send_commit_and_recovers_first_message(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let (peer, peer_token) = member(&pool, f.organization).await;
    sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(peer)
        .execute(&pool)
        .await
        .unwrap();
    let mut b = f.server.connect(&peer_token).await;
    // B views another conversation. DM discovery is not a Message subscription.
    sqlx::query(
        "INSERT INTO channel_members(organization_id,channel_id,member_id) VALUES($1,$2,$3)",
    )
    .bind(f.organization)
    .bind(f.channel)
    .bind(peer)
    .execute(&pool)
    .await
    .unwrap();
    subscribe(&mut b, f.channel, 0).await;
    ready(&mut b, f.channel, 0).await;
    let c = open(&f, peer).await;
    let path = format!("/api/v1/orgs/{}/dms/changes?lane=delta", f.organization);
    let initial = body(request(&f.app, "GET", &path, &peer_token, Value::Null).await).await;
    assert_eq!(initial["dms"][0]["id"], c.to_string());
    let key = Uuid::new_v4();
    let gate = messages::pause_commit(key);
    let sending = {
        let app = f.app.clone();
        let token = f.token.clone();
        tokio::spawn(async move {
            request(
                &app,
                "POST",
                &format!("/api/v1/channels/{c}/messages"),
                &token,
                json!({"client_message_id":key,"body":"first DM"}),
            )
            .await
        })
    };
    tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let delta_path = format!("{path}&cursor={}", initial["next_cursor"].as_str().unwrap());
    let early = body(request(&f.app, "GET", &delta_path, &peer_token, Value::Null).await).await;
    assert_eq!(early["dms"], json!([]));
    gate.release.add_permits(1);
    let sent = sending.await.unwrap();
    assert_eq!(sent.status(), StatusCode::CREATED);
    let canonical = body(sent).await;
    // No subsequent mutation or notice is needed. The saved early cursor advances only to its visible counter.
    let late_path = format!("{path}&cursor={}", early["next_cursor"].as_str().unwrap());
    let late = body(request(&f.app, "GET", &late_path, &peer_token, Value::Null).await).await;
    assert_eq!(late["dms"][0]["id"], c.to_string());
    let list = body(
        request(
            &f.app,
            "GET",
            &format!("/api/v1/orgs/{}/dms?channel_id={c}", f.organization),
            &peer_token,
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(list["dms"][0]["unread_count"], 1);
    assert_eq!(list["dms"][0]["mention_unread_count"], 0);
    drop(b);
    let mut reconnected = f.server.connect(&peer_token).await;
    subscribe(&mut reconnected, c, 0).await;
    assert_eq!(event(&mut reconnected).await["message"], canonical);
    ready(&mut reconnected, c, 1).await;
}

async fn body(r: Response) -> Value {
    serde_json::from_slice(&to_bytes(r.into_body(), 256 * 1024).await.unwrap()).unwrap()
}

#[fukulow_test::test]
async fn denied_dm_mutations_and_canonical_retries_publish_no_message_with_participant_controls(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let (peer, pt) = member(&pool, f.organization).await;
    sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(peer)
        .execute(&pool)
        .await
        .unwrap();
    let c = open(&f, peer).await;
    let mut a = f.server.connect(&f.token).await;
    let mut b = f.server.connect(&pt).await;
    for s in [&mut a, &mut b] {
        subscribe(s, c, 0).await;
        ready(s, c, 0).await;
    }
    let key = Uuid::new_v4();
    let first = send(&f, &f.token, c, key, "committed").await;
    assert_eq!(event(&mut a).await["message"], first);
    assert_eq!(event(&mut b).await["message"], first);
    assert_eq!(send(&f, &f.token, c, key, "committed").await, first);
    f.state.message_delivery.flush().await;
    silent(&mut a).await;
    silent(&mut b).await;
    let (_, outsider) = member(&pool, f.organization).await;
    for (token, input) in [
        (
            &outsider,
            json!({"client_message_id":Uuid::new_v4(),"body":"denied"}),
        ),
        (&f.token, json!({"client_message_id":key,"body":"changed"})),
        (
            &pt,
            json!({"client_message_id":Uuid::new_v4(),"body":"topic denied","topic_name":"No"}),
        ),
    ] {
        let r = request(
            &f.app,
            "POST",
            &format!("/api/v1/channels/{c}/messages"),
            token,
            input,
        )
        .await;
        assert!(r.status().is_client_error());
        f.state.message_delivery.flush().await;
        silent(&mut a).await;
        silent(&mut b).await;
    }
    let guest = send(&f, &pt, c, Uuid::new_v4(), "positive Guest").await;
    assert_eq!(guest["seq"], 2);
    assert_eq!(event(&mut a).await["message"], guest);
    assert_eq!(event(&mut b).await["message"], guest);
}

#[fukulow_test::test]
async fn dm_stale_revision_cannot_subscribe_replay_or_receive_even_after_explicit_renewal(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let (peer, pt) = member(&pool, f.organization).await;
    sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(peer)
        .execute(&pool)
        .await
        .unwrap();
    let c = open(&f, peer).await;
    send(&f, &f.token, c, Uuid::new_v4(), "history").await;
    let changes = crate::auth::SessionChanges::with_recheck_timing(
        Duration::from_millis(50),
        Duration::from_secs(5),
    );
    let fallback = changes.pause_fallback();
    let server = Server::start(crate::app(AppState {
        session_changes: changes,
        ..f.state.clone()
    }))
    .await;
    let mut live = server.connect(&pt).await;
    subscribe(&mut live, c, 1).await;
    ready(&mut live, c, 1).await;
    let mut idle = server.connect(&pt).await;
    let missing = Uuid::new_v4();
    subscribe(&mut idle, missing, 0).await;
    denied(&mut idle, missing).await;
    let mut replay = server.connect(&pt).await;
    let gate = pause(c);
    subscribe(&mut replay, c, 0).await;
    entered(&gate).await;
    fallback.entered().await;
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(peer)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(peer)
        .execute(&pool)
        .await
        .unwrap();
    let renewed = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{}/dms", f.organization),
        &f.token,
        json!({"member_id":peer,"renew":true}),
    )
    .await;
    assert_eq!(renewed.status(), StatusCode::OK);
    gate.release.add_permits(1);
    closed(&mut replay, CLOSE_ORGANIZATION_UNAVAILABLE).await;
    subscribe(&mut idle, c, 0).await;
    closed(&mut idle, CLOSE_ORGANIZATION_UNAVAILABLE).await;
    let fresh = send(&f, &f.token, c, Uuid::new_v4(), "fresh lifetime").await;
    f.state.message_delivery.flush().await;
    silent(&mut live).await;
    let mut current = server.connect(&pt).await;
    closed(&mut live, CLOSE_ORGANIZATION_UNAVAILABLE).await;
    subscribe(&mut current, c, 1).await;
    assert_eq!(event(&mut current).await["message"], fresh);
    ready(&mut current, c, 2).await;
    fallback.release();
}
