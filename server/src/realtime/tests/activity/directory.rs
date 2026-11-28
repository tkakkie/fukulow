use super::*;

#[fukulow_test::test]
async fn guest_last_shared_channel_removal_invalidates_own_directory(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (guest, token) = member(&pool, f.organization).await;
    role(&pool, &f, guest, "guest").await;
    grant(&pool, &f, f.channel, guest).await;
    let (outside, outside_token) = member(&pool, f.organization).await;
    role(&pool, &f, outside, "guest").await;
    let mut own = connect(&f, &token).await;
    let mut invisible = connect(&f, &outside_token).await;
    let response = request(
        &f.app,
        "DELETE",
        &format!("/api/v1/channels/{}/members/{guest}", f.channel),
        &f.token,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let events = notices(&f, &mut own).await;
    assert!(
        events.contains(&json!({"type":"members_changed"})),
        "{events:?}"
    );
    assert!(events.contains(&json!({"type":"channel_access_revoked","channel_id":f.channel})));
    assert!(notices(&f, &mut invisible).await.is_empty());
}

#[fukulow_test::test]
async fn invite_acceptance_notifies_members_changed_to_non_guests_only(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (guest, token) = member(&pool, f.organization).await;
    role(&pool, &f, guest, "guest").await;
    let mut denied = connect(&f, &token).await;
    let mut allowed = connect(&f, &f.token).await;
    let email = format!("{}@example.invalid", Uuid::new_v4());
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{}/invites", f.organization),
        &f.token,
        json!({"email":email,"role":"member"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let invite: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap();
    assert!(notices(&f, &mut allowed).await.is_empty());
    let response=f.app.clone().oneshot(Request::post(format!("/api/v1/orgs/{}/invites/accept",f.organization)).header(header::CONTENT_TYPE,"application/json").body(Body::from(json!({"email":email,"name":"New Member","password":"invite password 307","token":invite["token"]}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        notices(&f, &mut allowed).await,
        vec![json!({"type":"members_changed"})]
    );
    assert!(notices(&f, &mut denied).await.is_empty());
}

#[fukulow_test::test]
async fn role_change_and_deactivation_notify_members_changed_per_directory_rule(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, _) = member(&pool, f.organization).await;
    let (guest, guest_token) = member(&pool, f.organization).await;
    role(&pool, &f, guest, "guest").await;
    let mut invisible = connect(&f, &guest_token).await;
    let mut control = connect(&f, &f.token).await;
    for (method, suffix, body) in [
        ("PATCH", "role", json!({"role":"admin"})),
        ("POST", "deactivate", Value::Null),
    ] {
        let response = request(
            &f.app,
            method,
            &format!("/api/v1/orgs/{}/members/{target}/{suffix}", f.organization),
            &f.token,
            body,
        )
        .await;
        assert!(response.status().is_success());
        assert!(
            notices(&f, &mut control)
                .await
                .contains(&json!({"type":"members_changed"}))
        );
        // This Guest shares no granted Channel with the changed Member.
        assert!(notices(&f, &mut invisible).await.is_empty());
    }
}

#[fukulow_test::test]
async fn guest_directory_notices_follow_shared_grants_and_deny_unrelated_guests(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, _) = member(&pool, f.organization).await;
    let (shared, shared_token) = member(&pool, f.organization).await;
    let (unrelated, unrelated_token) = member(&pool, f.organization).await;
    role(&pool, &f, shared, "guest").await;
    role(&pool, &f, unrelated, "guest").await;
    let channel = channel(&pool, f.organization, f.member, true).await;
    grant(&pool, &f, channel, shared).await;
    let mut shared_socket = connect(&f, &shared_token).await;
    let mut unrelated_socket = connect(&f, &unrelated_token).await;

    for (method, path, body) in [
        (
            "POST",
            format!("/api/v1/channels/{channel}/members"),
            json!({"member_id":target}),
        ),
        (
            "PATCH",
            format!("/api/v1/orgs/{}/members/{target}/role", f.organization),
            json!({"role":"admin"}),
        ),
        (
            "DELETE",
            format!("/api/v1/channels/{channel}/members/{target}"),
            Value::Null,
        ),
    ] {
        let response = request(&f.app, method, &path, &f.token, body).await;
        assert!(
            response.status().is_success(),
            "{method} {path}: {}",
            response.status()
        );
        assert!(
            notices(&f, &mut shared_socket)
                .await
                .contains(&json!({"type":"members_changed"}))
        );
        assert!(notices(&f, &mut unrelated_socket).await.is_empty());
    }
}

#[fukulow_test::test]
async fn guest_directory_loss_discards_older_authorized_notice_but_keeps_fresh_publication(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, _) = member(&pool, f.organization).await;
    let (guest, guest_token) = member(&pool, f.organization).await;
    role(&pool, &f, guest, "guest").await;
    let private = channel(&pool, f.organization, f.member, true).await;
    grant(&pool, &f, private, guest).await;
    grant(&pool, &f, private, target).await;
    let mut guest_socket = connect(&f, &guest_token).await;
    let mut control = connect(&f, &f.token).await;
    let gate =
        crate::channels::activity::pause(f.organization, Uuid::nil(), "directory_authorized");
    let response = request(
        &f.app,
        "PATCH",
        &format!("/api/v1/orgs/{}/members/{target}/role", f.organization),
        &f.token,
        json!({"role":"admin"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    gate.entered().await;

    let response = request(
        &f.app,
        "DELETE",
        &format!("/api/v1/channels/{private}/members/{target}"),
        &f.token,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    // The removal's fresh A4 notice still reaches the Guest, after the last shared grant is gone.
    let mut fresh = false;
    for _ in 0..3 {
        if raw_event(&mut guest_socket).await == json!({"type":"members_changed"}) {
            fresh = true;
            break;
        }
    }
    assert!(
        fresh,
        "the removal must publish a fresh directory invalidation"
    );
    gate.release();
    let later = notices(&f, &mut guest_socket).await;
    assert!(
        !later.contains(&json!({"type":"members_changed"})),
        "{later:?}"
    );
    assert!(
        notices(&f, &mut control)
            .await
            .contains(&json!({"type":"members_changed"}))
    );
}
