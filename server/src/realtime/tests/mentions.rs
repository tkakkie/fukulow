use super::*;

async fn grant(pool: &PgPool, org: Uuid, channel: Uuid, target: Uuid) {
    sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3) ON CONFLICT (organization_id,channel_id,member_id) DO UPDATE SET membership_revision=(SELECT membership_revision FROM users WHERE organization_id=$1 AND id=$3)")
        .bind(org).bind(channel).bind(target).execute(pool).await.unwrap();
}

#[fukulow_test::test]
async fn mention_live_and_replay_follow_current_names_and_never_accept_later_grants(pool: PgPool) {
    let f = fixture(&pool).await;
    let c = channel(&pool, f.organization, f.member, true).await;
    let (target, _) = member(&pool, f.organization).await;
    let (denied, _) = member(&pool, f.organization).await;
    grant(&pool, f.organization, c, target).await;
    let mut live = f.server.connect(&f.token).await;
    subscribe(&mut live, c, 0).await;
    ready(&mut live, c, 0).await;
    let key = Uuid::new_v4();
    let gate = messages::pause_publication(key);
    let text = format!("@{{member:{target}}} @{{member:{denied}}}");
    let message = send(&f, &f.token, c, key, &text).await;
    tokio::time::timeout(Duration::from_secs(3), gate.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    assert_eq!(
        message["mentions"],
        json!([{"member_id":target,"name":"Member"}])
    );
    sqlx::query("UPDATE users SET name='Current',deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2").bind(f.organization).bind(target).execute(&pool).await.unwrap();
    grant(&pool, f.organization, c, denied).await;
    gate.release.add_permits(1);
    let received = event(&mut live).await;
    assert_eq!(received["type"], "message");
    assert_eq!(received["message"]["body"], text);
    assert_eq!(
        received["message"]["mentions"],
        json!([{"member_id":target,"name":"Current"}])
    );
    let mut replay = f.server.connect(&f.token).await;
    subscribe(&mut replay, c, 0).await;
    assert_eq!(event(&mut replay).await, received);
    ready(&mut replay, c, 1).await;
    f.state.message_delivery.flush().await;
    silent(&mut live).await;
    silent(&mut replay).await;
    let retried = send(&f, &f.token, c, key, &text).await;
    assert_eq!(retried, received["message"]);
    silent(&mut live).await;
}

#[fukulow_test::test]
async fn mention_lost_channel_live_and_fetched_replay_never_handoff_identities(pool: PgPool) {
    for phase in ["live", "page", "frame"] {
        let f = fixture(&pool).await;
        sqlx::query("UPDATE users SET role='owner' WHERE organization_id=$1 AND id=$2")
            .bind(f.organization)
            .bind(f.member)
            .execute(&pool)
            .await
            .unwrap();
        let c = channel(&pool, f.organization, f.member, true).await;
        let (reader, token) = member(&pool, f.organization).await;
        grant(&pool, f.organization, c, reader).await;
        let mut socket = f.server.connect(&token).await;
        let gate = access_loss::gate(
            c,
            phase,
            if phase == "page" {
                0
            } else if phase == "frame" {
                2
            } else {
                1
            },
        );
        if phase == "live" {
            subscribe(&mut socket, c, 0).await;
            ready(&mut socket, c, 0).await;
        }
        for _ in 0..3 {
            send(
                &f,
                &f.token,
                c,
                Uuid::new_v4(),
                &format!("@{{member:{reader}}}"),
            )
            .await;
        }
        if phase != "live" {
            subscribe(&mut socket, c, 0).await;
        }
        entered(&gate).await;
        let mut control = f.server.connect(&f.token).await;
        subscribe(&mut control, c, 0).await;
        if phase == "frame" {
            assert_eq!(event(&mut socket).await["message"]["seq"], 1);
        }
        assert_eq!(
            request(
                &f.app,
                "DELETE",
                &format!("/api/v1/channels/{c}/members/{reader}"),
                &f.token,
                Value::Null
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
        gate.release.add_permits(1);
        access_loss::access_lost(&mut socket, c).await;
        silent(&mut socket).await;
        for seq in 1..=3 {
            let m = event(&mut control).await;
            assert_eq!(m["message"]["seq"], seq);
            assert_eq!(
                m["message"]["mentions"],
                json!([{"member_id":reader,"name":"Member"}])
            );
        }
        subscribe(&mut socket, c, 0).await;
        denied(&mut socket, c).await;
        silent(&mut socket).await;
        // Other accessible Channels remain readable and delivered.
        subscribe(&mut socket, f.channel, 0).await;
        ready(&mut socket, f.channel, 0).await;
        let ordinary = send(
            &f,
            &f.token,
            f.channel,
            Uuid::new_v4(),
            &format!("@{{member:{reader}}}"),
        )
        .await;
        assert_eq!(event(&mut socket).await["message"], ordinary);
    }
}
