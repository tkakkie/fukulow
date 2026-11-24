use super::*;

#[fukulow_test::test]
async fn stale_generation_subscribe_denials_cover_guest_dm_roles_and_foreign_organization(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let old = Uuid::new_v4();
    let (peer, peer_token) = member(&pool, f.organization).await;
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{}/dms", f.organization),
        &f.token,
        json!({"member_id":peer}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let data: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1 << 20).await.unwrap()).unwrap();
    let dm: Uuid = data["id"].as_str().unwrap().parse().unwrap();
    let (guest, guest_token) = member(&pool, f.organization).await;
    sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(guest)
        .execute(&pool)
        .await
        .unwrap();
    let mut socket = f.server.connect(&guest_token).await;
    control(
        &mut socket,
        ClientMessage::Subscribe {
            history_generation: Some(old),
            channel_id: f.channel,
            after_seq: 0,
        },
    )
    .await
    .unwrap();
    denied(&mut socket, f.channel).await;
    // Same Guest and public Channel become authorized only after an explicit grant.
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
    )
    .bind(f.organization)
    .bind(f.channel)
    .bind(guest)
    .execute(&pool)
    .await
    .unwrap();
    control(
        &mut socket,
        ClientMessage::Subscribe {
            history_generation: Some(old),
            channel_id: f.channel,
            after_seq: 0,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        event(&mut socket).await,
        json!({"type":"error","code":"history_generation_changed","channel_id":f.channel})
    );
    subscribe(&mut socket, f.channel, 0).await;
    ready(&mut socket, f.channel, 0).await;
    for role in ["member", "owner", "admin", "guest", "foreign"] {
        let org = if role == "foreign" {
            organization(&pool).await
        } else {
            f.organization
        };
        let (actor, token) = member(&pool, org).await;
        if role != "foreign" {
            sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(actor)
                .bind(role)
                .execute(&pool)
                .await
                .unwrap();
        }
        let mut denied_socket = f.server.connect(&token).await;
        for channel_id in if role == "foreign" {
            vec![dm, f.channel, Uuid::new_v4()]
        } else {
            vec![dm, Uuid::new_v4()]
        } {
            control(
                &mut denied_socket,
                ClientMessage::Subscribe {
                    history_generation: Some(old),
                    channel_id,
                    after_seq: 0,
                },
            )
            .await
            .unwrap();
            denied(&mut denied_socket, channel_id).await;
        }
        // A granted private Channel is a positive control for every denied Role.
        {
            let own = channel(&pool, org, actor, true).await;
            subscribe(&mut denied_socket, own, 0).await;
            ready(&mut denied_socket, own, 0).await;
        }
    }
    // Both DM participants can discover the generation and subscribe; a stale one refuses.
    for token in [&f.token, &peer_token] {
        let mut allowed = f.server.connect(token).await;
        control(
            &mut allowed,
            ClientMessage::Subscribe {
                history_generation: Some(old),
                channel_id: dm,
                after_seq: 0,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            event(&mut allowed).await,
            json!({"type":"error","code":"history_generation_changed","channel_id":dm})
        );
        subscribe(&mut allowed, dm, 0).await;
        ready(&mut allowed, dm, 0).await;
    }
}

#[fukulow_test::test]
async fn subscribe_handoff_generation_recheck_preserves_access_and_organization_loss(pool: PgPool) {
    for loss in ["grant", "member"] {
        let f = fixture(&pool).await;
        let private = channel(&pool, f.organization, f.member, true).await;
        let gate = access_loss::gate(private, "handoff_generation", 0);
        let mut socket = f.server.connect(&f.token).await;
        subscribe(&mut socket, private, 0).await;
        gate.entered().await;
        if loss == "grant" {
            sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(f.organization).bind(private).bind(f.member).execute(&pool).await.unwrap();
        } else {
            sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
                .bind(f.organization)
                .bind(f.member)
                .execute(&pool)
                .await
                .unwrap();
        }
        gate.release.add_permits(1);
        if loss == "grant" {
            assert_eq!(
                event(&mut socket).await,
                json!({"type":"channel_access_lost","channel_id":private})
            );
            subscribe(&mut socket, private, 0).await;
            denied(&mut socket, private).await;
        } else {
            closed(&mut socket, CLOSE_ORGANIZATION_UNAVAILABLE).await;
        }
    }
}

#[fukulow_test::test]
async fn generation_subscribe_denial_hides_private_channels_and_reconnect_uses_rotated_epoch(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    let (_, stranger) = member(&pool, f.organization).await;
    let old: Uuid = crate::database::organization_read_only(
        &pool,
        f.organization,
        async |tx: &mut sqlx::PgConnection| {
            crate::auth::history::generation(tx, f.organization).await
        },
    )
    .await
    .unwrap();
    let mut denied_socket = f.server.connect(&stranger).await;
    for target in [private, Uuid::new_v4()] {
        control(
            &mut denied_socket,
            ClientMessage::Subscribe {
                history_generation: Some(Uuid::new_v4()),
                channel_id: target,
                after_seq: 0,
            },
        )
        .await
        .unwrap();
        denied(&mut denied_socket, target).await;
    }
    let mut socket = f.server.connect(&f.token).await;
    control(
        &mut socket,
        ClientMessage::Subscribe {
            history_generation: Some(old),
            channel_id: private,
            after_seq: 0,
        },
    )
    .await
    .unwrap();
    let initial = event(&mut socket).await;
    assert_eq!(initial["history_generation"], old.to_string());
    control(
        &mut socket,
        ClientMessage::Subscribe {
            history_generation: Some(old),
            channel_id: private,
            after_seq: i64::MAX,
        },
    )
    .await
    .unwrap();
    // The duplicate must finish its check under the old generation before rotation; otherwise it
    // correctly unsubscribes with history_generation_changed (#553). The socket loop handles controls
    // inline, so the Pong follows it, and any non-notice reply to the no-op duplicate fails here.
    super::activity::collect(
        &f.state.message_delivery.channel_access.activity,
        &mut socket,
    )
    .await;
    crate::auth::history::rotate(&pool, Some(f.organization))
        .await
        .unwrap();
    let message = send(&f, &f.token, private, Uuid::new_v4(), "after rotation").await;
    let live = event(&mut socket).await;
    assert_eq!(live["message"], message);
    assert_ne!(message["history_generation"], old.to_string());
    control(
        &mut socket,
        ClientMessage::Subscribe {
            history_generation: Some(old),
            channel_id: private,
            after_seq: 0,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        event(&mut socket).await,
        json!({"type":"error","code":"history_generation_changed","channel_id":private})
    );
    control(
        &mut socket,
        ClientMessage::Unsubscribe {
            channel_id: private,
        },
    )
    .await
    .unwrap();
    control(
        &mut socket,
        ClientMessage::Subscribe {
            history_generation: Some(old),
            channel_id: private,
            after_seq: 0,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        event(&mut socket).await,
        json!({"type":"error","code":"history_generation_changed","channel_id":private})
    );
    let current = Uuid::parse_str(message["history_generation"].as_str().unwrap()).unwrap();
    control(
        &mut socket,
        ClientMessage::Subscribe {
            history_generation: Some(current),
            channel_id: private,
            after_seq: 0,
        },
    )
    .await
    .unwrap();
    assert_eq!(event(&mut socket).await["message"], message);
    let handoff = event(&mut socket).await;
    assert_eq!(handoff["history_generation"], current.to_string());
    assert_eq!(handoff["caught_up_seq"], 1);
}
