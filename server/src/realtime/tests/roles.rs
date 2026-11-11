use super::*;

#[sqlx::test]
async fn guest_rest_subscribe_replay_and_live_denials_have_explicit_grant_positive_controls(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let (guest, token) = member(&pool, f.organization).await;
    sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(guest)
        .execute(&pool)
        .await
        .unwrap();
    let private = channel(&pool, f.organization, f.member, true).await;
    for channel in [f.channel, private] {
        let sent = topic_send(&f, &f.token, channel, Uuid::new_v4()).await;
        let topic = sent["topic_id"].as_str().unwrap();
        let mut socket = f.server.connect(&token).await;
        for granted in [false, true] {
            if granted {
                sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)").bind(f.organization).bind(channel).bind(guest).execute(&pool).await.unwrap();
            }
            for suffix in [
                "messages".to_string(),
                "timeline".into(),
                "topics".into(),
                format!("topics/{topic}"),
                format!("topics/{topic}/messages"),
            ] {
                let r = request(
                    &f.app,
                    "GET",
                    &format!("/api/v1/channels/{channel}/{suffix}"),
                    &token,
                    Value::Null,
                )
                .await;
                assert_eq!(
                    r.status(),
                    if granted {
                        StatusCode::OK
                    } else {
                        StatusCode::NOT_FOUND
                    }
                );
            }
            let r = request(
                &f.app,
                "POST",
                &format!("/api/v1/channels/{channel}/messages"),
                &token,
                json!({"client_message_id":Uuid::new_v4(),"body":"Guest send"}),
            )
            .await;
            assert_eq!(
                r.status(),
                if granted {
                    StatusCode::CREATED
                } else {
                    StatusCode::NOT_FOUND
                }
            );
            subscribe(&mut socket, channel, 0).await;
            if granted {
                assert_eq!(event(&mut socket).await["message"], sent);
                assert_eq!(event(&mut socket).await["type"], "message");
                ready(&mut socket, channel, 2).await;
                let live = send(&f, &f.token, channel, Uuid::new_v4(), "live").await;
                assert_eq!(event(&mut socket).await["message"], live);
            } else {
                assert_eq!(event(&mut socket).await["code"], "channel_not_found");
            }
        }
    }
}

#[sqlx::test]
async fn delivery_reads_role_after_subscription_and_after_http_response(pool: PgPool) {
    let f = fixture(&pool).await;
    let (reader, token) = member(&pool, f.organization).await;
    let mut socket = f.server.connect(&token).await;
    subscribe(&mut socket, f.channel, 0).await;
    ready(&mut socket, f.channel, 0).await;
    let first = send(&f, &f.token, f.channel, Uuid::new_v4(), "positive").await;
    assert_eq!(event(&mut socket).await["message"], first);
    let key = Uuid::new_v4();
    let gate = messages::pause_publication(key);
    let blocked = send(&f, &f.token, f.channel, key, "must not reach Guest").await;
    gate.entered.acquire().await.unwrap().forget();
    sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(reader)
        .execute(&pool)
        .await
        .unwrap();
    gate.release.add_permits(1);
    f.state.message_delivery.flush().await;
    access_loss::access_lost(&mut socket, f.channel).await;
    silent(&mut socket).await;
    let mut replay = f.server.connect(&token).await;
    subscribe(&mut replay, f.channel, 0).await;
    assert_eq!(event(&mut replay).await["code"], "channel_not_found");
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
    )
    .bind(f.organization)
    .bind(f.channel)
    .bind(reader)
    .execute(&pool)
    .await
    .unwrap();
    subscribe(&mut socket, f.channel, 1).await;
    assert_eq!(event(&mut socket).await["message"], blocked);
    ready(&mut socket, f.channel, 2).await;
    let allowed = send(
        &f,
        &f.token,
        f.channel,
        Uuid::new_v4(),
        "explicitly added Guest",
    )
    .await;
    // Shared-gap recovery includes only messages authorized at its fresh decision.
    assert_eq!(event(&mut socket).await["message"], allowed);
    subscribe(&mut replay, f.channel, 0).await;
    for _ in 0..3 {
        assert_eq!(super::event(&mut replay).await["type"], "message");
    }
    ready(&mut replay, f.channel, 3).await;
}

async fn topic_send(f: &Fixture, token: &str, channel: Uuid, key: Uuid) -> Value {
    let r = request(
        &f.app,
        "POST",
        &format!("/api/v1/channels/{channel}/messages"),
        token,
        json!({"client_message_id":key,"body":"Topic","topic_name":"Test"}),
    )
    .await;
    assert_eq!(r.status(), StatusCode::CREATED);
    serde_json::from_slice(&to_bytes(r.into_body(), 32768).await.unwrap()).unwrap()
}
