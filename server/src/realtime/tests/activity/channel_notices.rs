use super::*;

#[fukulow_test::test]
async fn public_channel_creation_notifies_non_guests_and_private_creation_only_the_creator(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let (_, other) = member(&pool, f.organization).await;
    let mut creator = connect(&f, &f.token).await;
    let mut reader = connect(&f, &other).await;
    for visibility in ["public", "private"] {
        let response = request(
            &f.app,
            "POST",
            "/api/v1/channels",
            &f.token,
            json!({"name":visibility,"visibility":visibility}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap();
        let expected = json!({"type":"channel_access_gained","channel_id":body["id"]});
        assert_eq!(notices(&f, &mut creator).await, vec![expected.clone()]);
        assert_eq!(
            notices(&f, &mut reader).await,
            if visibility == "public" {
                vec![expected]
            } else {
                vec![]
            }
        );
    }
}

#[fukulow_test::test]
async fn grant_notifies_target_gain_and_channel_viewers_members_changed(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, token) = member(&pool, f.organization).await;
    let (_, outside) = member(&pool, f.organization).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    let mut own = connect(&f, &token).await;
    let mut control = connect(&f, &f.token).await;
    let mut denied = connect(&f, &outside).await;
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/channels/{private}/members"),
        &f.token,
        json!({"member_id":target}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let events = notices(&f, &mut own).await;
    assert!(
        events.contains(&json!({"type":"channel_access_gained","channel_id":private})),
        "{events:?}"
    );
    assert!(events.contains(&json!({"type":"channel_members_changed","channel_id":private})));
    let control_events = notices(&f, &mut control).await;
    assert!(
        control_events.contains(&json!({"type":"channel_members_changed","channel_id":private}))
    );
    assert!(control_events.contains(&json!({"type":"members_changed"})));
    assert_eq!(
        notices(&f, &mut denied).await,
        vec![json!({"type":"members_changed"})]
    );
}
#[fukulow_test::test]
async fn manager_right_change_notifies_target_list_and_channel_viewers(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, token) = member(&pool, f.organization).await;
    let (_, outside) = member(&pool, f.organization).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    grant(&pool, &f, private, target).await;
    let mut own = connect(&f, &token).await;
    let mut control = connect(&f, &f.token).await;
    let mut denied = connect(&f, &outside).await;
    let response = request(
        &f.app,
        "PATCH",
        &format!("/api/v1/channels/{private}/members/{target}"),
        &f.token,
        json!({"manager":true}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let events = notices(&f, &mut own).await;
    assert!(events.contains(&json!({"type":"channel_list_changed"})));
    assert!(events.contains(&json!({"type":"channel_members_changed","channel_id":private})));
    assert_eq!(
        notices(&f, &mut control).await,
        vec![json!({"type":"channel_members_changed","channel_id":private})]
    );
    assert!(notices(&f, &mut denied).await.is_empty());
    let response = request(
        &f.app,
        "PATCH",
        &format!("/api/v1/channels/{private}/members/{target}"),
        &f.token,
        json!({"manager":true}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(notices(&f, &mut own).await.is_empty());
    assert!(notices(&f, &mut control).await.is_empty());
}
#[fukulow_test::test]
async fn promotion_from_guest_notifies_gained_public_channels(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, token) = member(&pool, f.organization).await;
    role(&pool, &f, target, "guest").await;
    let (outside, outside_token) = member(&pool, f.organization).await;
    role(&pool, &f, outside, "guest").await;
    let mut own = connect(&f, &token).await;
    let mut control = connect(&f, &f.token).await;
    let mut denied = connect(&f, &outside_token).await;
    let response = request(
        &f.app,
        "PATCH",
        &format!("/api/v1/orgs/{}/members/{target}/role", f.organization),
        &f.token,
        json!({"role":"member"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        notices(&f, &mut own)
            .await
            .contains(&json!({"type":"channel_access_gained","channel_id":f.channel}))
    );
    assert!(
        notices(&f, &mut control)
            .await
            .contains(&json!({"type":"members_changed"}))
    );
    assert!(notices(&f, &mut denied).await.is_empty());
}
