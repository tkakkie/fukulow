use super::*;

async fn post_during_session_check(f: &Fixture, token: &str) -> (Client, Arc<Gate>) {
    let check = f.state.session_changes.pause_session_check();
    let socket = f.server.connect(token).await;
    check.entered().await;
    // The client has received the 101. Finish publication before the Session check continues.
    post(f, f.channel).await;
    tokio::time::timeout(
        Duration::from_secs(5),
        f.state.message_delivery.channel_access.activity.drained(),
    )
    .await
    .unwrap();
    (socket, check)
}

#[fukulow_test::test]
async fn activity_committed_after_open_reaches_socket_before_subscription(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_, token) = member(&pool, f.organization).await;
    let (mut socket, check) = post_during_session_check(&f, &token).await;

    check.release();
    assert_eq!(
        raw_event(&mut socket).await,
        json!({"type":"activity_ready"})
    );
    assert_eq!(notices(&f, &mut socket).await, vec![activity(f.channel, 1)]);
}

#[fukulow_test::test]
async fn session_ended_during_upgrade_check_receives_no_activity(pool: PgPool) {
    let f = fixture(&pool).await;
    let (reader, token) = member(&pool, f.organization).await;
    let control = session::another_session(&pool, f.organization, reader).await;
    let mut allowed = connect(&f, &control).await;
    let (mut denied, check) = post_during_session_check(&f, &token).await;
    assert_eq!(
        notices(&f, &mut allowed).await,
        vec![activity(f.channel, 1)]
    );

    let response = request(&f.app, "DELETE", "/api/v1/session", &token, Value::Null).await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    check.release();
    raw_closed(&mut denied, CLOSE_SESSION_ENDED).await;
}

#[fukulow_test::test]
async fn membership_lost_during_upgrade_check_receives_no_activity(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (reader, token) = member(&pool, f.organization).await;
    let (_, control) = member(&pool, f.organization).await;
    let mut allowed = connect(&f, &control).await;
    let (mut denied, check) = post_during_session_check(&f, &token).await;
    assert_eq!(
        notices(&f, &mut allowed).await,
        vec![activity(f.channel, 1)]
    );

    let response = request(
        &f.app,
        "POST",
        &format!(
            "/api/v1/orgs/{}/members/{reader}/deactivate",
            f.organization
        ),
        &f.token,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    check.release();
    raw_closed(&mut denied, CLOSE_ORGANIZATION_UNAVAILABLE).await;
}
