use super::*;

#[fukulow_test::test]
async fn own_sends_emit_no_channel_activity_to_the_sender_but_reach_other_members(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_, other) = member(&pool, f.organization).await;
    let second = session::another_session(&pool, f.organization, f.member).await;
    let mut sender = connect(&f, &f.token).await;
    let mut own_other = connect(&f, &second).await;
    let mut reader = connect(&f, &other).await;
    post(&f, f.channel).await;
    assert_eq!(notices(&f, &mut reader).await, vec![activity(f.channel, 1)]);
    assert!(notices(&f, &mut sender).await.is_empty());
    assert!(notices(&f, &mut own_other).await.is_empty());
}
#[fukulow_test::test]
async fn private_channel_activity_skips_non_members(pool: PgPool) {
    let f = fixture(&pool).await;
    let (reader, token) = member(&pool, f.organization).await;
    let (_, denied) = member(&pool, f.organization).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    grant(&pool, &f, private, reader).await;
    let mut allowed = connect(&f, &token).await;
    let mut denied = connect(&f, &denied).await;
    post(&f, private).await;
    assert_eq!(notices(&f, &mut allowed).await, vec![activity(private, 1)]);
    assert!(notices(&f, &mut denied).await.is_empty());
}
#[fukulow_test::test]
async fn guest_without_grant_receives_no_public_channel_activity_or_creation(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (guest, denied) = member(&pool, f.organization).await;
    let (grantee, allowed) = member(&pool, f.organization).await;
    role(&pool, &f, guest, "guest").await;
    role(&pool, &f, grantee, "guest").await;
    grant(&pool, &f, f.channel, grantee).await;
    let (_, ordinary) = member(&pool, f.organization).await;
    let mut denied = connect(&f, &denied).await;
    let mut allowed = connect(&f, &allowed).await;
    let mut ordinary = connect(&f, &ordinary).await;
    post(&f, f.channel).await;
    assert_eq!(
        notices(&f, &mut allowed).await,
        vec![activity(f.channel, 1)]
    );
    assert_eq!(
        notices(&f, &mut ordinary).await,
        vec![activity(f.channel, 1)]
    );
    assert!(notices(&f, &mut denied).await.is_empty());
    let response = request(
        &f.app,
        "POST",
        "/api/v1/channels",
        &f.token,
        json!({"name":"new-public","visibility":"public"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert!(notices(&f, &mut denied).await.is_empty());
    assert!(notices(&f, &mut allowed).await.is_empty());
    assert_eq!(
        notices(&f, &mut ordinary).await[0]["type"],
        "channel_access_gained"
    );
}
#[fukulow_test::test]
async fn other_organization_socket_of_same_account_receives_nothing(pool: PgPool) {
    let f = fixture(&pool).await;
    let foreign = organization(&pool).await;
    sqlx::query("INSERT INTO users (organization_id,id,account_id,name,role) SELECT $1,$2,account_id,'Other','member' FROM users WHERE organization_id=$3 AND id=$4")
        .bind(foreign).bind(Uuid::new_v4()).bind(f.organization).bind(f.member).execute(&pool).await.unwrap();
    let foreign_token = f.token.clone();
    let mut request = format!("ws://{}/api/v1/orgs/{foreign}/ws", f.server.address)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {foreign_token}").parse().unwrap(),
    );
    let mut denied = tokio_tungstenite::connect_async(request).await.unwrap().0;
    assert_eq!(raw_event(&mut denied).await["type"], "activity_ready");
    let (_, reader) = member(&pool, f.organization).await;
    let mut allowed = connect(&f, &reader).await;
    post(&f, f.channel).await;
    assert_eq!(
        notices(&f, &mut allowed).await,
        vec![activity(f.channel, 1)]
    );
    assert!(notices(&f, &mut denied).await.is_empty());
}

#[fukulow_test::test]
async fn stale_membership_revision_socket_matches_no_recipient(pool: PgPool) {
    let f = fixture(&pool).await;
    let (target, token) = member(&pool, f.organization).await;
    let (_, control) = member(&pool, f.organization).await;
    let mut stale = connect(&f, &token).await;
    let mut allowed = connect(&f, &control).await;
    sqlx::query(
        "UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
    )
    .bind(f.organization)
    .bind(target)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(target)
        .execute(&pool)
        .await
        .unwrap();
    post(&f, f.channel).await;
    assert_eq!(
        notices(&f, &mut allowed).await,
        vec![activity(f.channel, 1)]
    );
    assert!(notices(&f, &mut stale).await.is_empty());
}
#[fukulow_test::test]
async fn ended_session_closes_4001_and_receives_no_notice(pool: PgPool) {
    let f = fixture(&pool).await;
    let (target, token) = member(&pool, f.organization).await;
    let other = session::another_session(&pool, f.organization, target).await;
    let mut denied = connect(&f, &token).await;
    let mut allowed = connect(&f, &other).await;
    let response = request(&f.app, "DELETE", "/api/v1/session", &token, Value::Null).await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    post(&f, f.channel).await;
    raw_closed(&mut denied, 4001).await;
    assert_eq!(
        notices(&f, &mut allowed).await,
        vec![activity(f.channel, 1)]
    );
}
#[fukulow_test::test]
async fn deactivated_member_closes_4003_and_receives_no_notice(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, token) = member(&pool, f.organization).await;
    let (_, control) = member(&pool, f.organization).await;
    let mut denied = connect(&f, &token).await;
    let mut allowed = connect(&f, &control).await;
    let response = request(
        &f.app,
        "POST",
        &format!(
            "/api/v1/orgs/{}/members/{target}/deactivate",
            f.organization
        ),
        &f.token,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    raw_closed(&mut denied, 4003).await;
    notices(&f, &mut allowed).await;
    post(&f, f.channel).await;
    assert_eq!(
        notices(&f, &mut allowed).await,
        vec![activity(f.channel, 1)]
    );
}
