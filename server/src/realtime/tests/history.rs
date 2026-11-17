use super::*;

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
