use super::*;

async fn fallback_close(socket: &mut Client, code: u16) {
    let frame = tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let tungstenite::Message::Close(Some(close)) = frame else {
        panic!("expected close")
    };
    assert_eq!(u16::from(close.code), code);
}

pub(super) async fn another_session(pool: &PgPool, organization: Uuid, member: Uuid) -> String {
    let token = format!(
        "{organization}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    sqlx::query("INSERT INTO sessions (organization_id, token_hash, user_id) VALUES ($1, $2, $3)")
        .bind(organization)
        .bind(Sha256::digest(token.as_bytes()).to_vec())
        .bind(member)
        .execute(pool)
        .await
        .unwrap();
    token
}

#[sqlx::test]
async fn sign_out_burst_over_1024_keeps_unrelated_sessions_open(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_, other_member) = member(&pool, f.organization).await;
    let foreign_organization = organization(&pool).await;
    let (foreign_member, foreign_token) = member(&pool, foreign_organization).await;
    let foreign_channel = channel(&pool, foreign_organization, foreign_member, false).await;
    let mut own = f.server.connect(&f.token).await;
    let mut other = f.server.connect(&other_member).await;
    let mut foreign = f.server.connect(&foreign_token).await;
    for socket in [&mut own, &mut other] {
        subscribe(socket, f.channel, 0).await;
        ready(socket, f.channel, 0).await;
    }
    subscribe(&mut foreign, foreign_channel, 0).await;
    ready(&mut foreign, foreign_channel, 0).await;
    for _ in 0..1050 {
        let token = another_session(&pool, f.organization, f.member).await;
        assert_eq!(
            request(&f.app, "DELETE", "/api/v1/session", &token, Value::Null)
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
    }
    let canonical = post(&f, f.channel).await;
    assert_eq!(event(&mut own).await["message"], canonical);
    assert_eq!(event(&mut other).await["message"], canonical);
    let canonical = send(
        &f,
        &foreign_token,
        foreign_channel,
        Uuid::new_v4(),
        "still authorized",
    )
    .await;
    assert_eq!(event(&mut foreign).await["message"], canonical);
}

#[sqlx::test]
async fn lost_sign_out_notification_is_bounded_for_idle_and_replaying_sockets(pool: PgPool) {
    let f = fixture(&pool).await;
    let server = Server::start(crate::app(AppState {
        session_changes: crate::auth::SessionChanges::with_recheck_timing(
            Duration::from_secs(1),
            Duration::from_millis(500),
        ),
        ..f.state.clone()
    }))
    .await;
    let other_token = another_session(&pool, f.organization, f.member).await;
    let mut idle = server.connect(&f.token).await;
    subscribe(&mut idle, f.channel, 0).await;
    ready(&mut idle, f.channel, 0).await;
    let mut replay = server.connect(&f.token).await;
    let gate = pause(f.channel);
    subscribe(&mut replay, f.channel, 0).await;
    entered(&gate).await;
    let mut other = server.connect(&other_token).await;
    subscribe(&mut other, f.channel, 0).await;
    ready(&mut other, f.channel, 0).await;
    // Inject a lost notification: sign-out commits using an isolated notification registry.
    let isolated = crate::app(AppState {
        session_changes: Default::default(),
        ..f.state.clone()
    });
    let started = tokio::time::Instant::now();
    assert_eq!(
        request(
            &isolated,
            "DELETE",
            "/api/v1/session",
            &f.token,
            Value::Null
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    // Prove this exercises the fallback, rather than an immediate revocation/expiry signal.
    silent(&mut idle).await;
    silent(&mut replay).await;
    tokio::join!(
        fallback_close(&mut idle, CLOSE_SESSION_ENDED),
        fallback_close(&mut replay, CLOSE_SESSION_ENDED)
    );
    assert!(started.elapsed() <= Duration::from_secs(3));
    let canonical = send(
        &f,
        &other_token,
        f.channel,
        Uuid::new_v4(),
        "fallback preserves valid session",
    )
    .await;
    assert_eq!(event(&mut other).await["message"], canonical);
}

#[sqlx::test]
async fn fallback_database_failure_closes_with_internal_error(pool: PgPool) {
    let f = fixture(&pool).await;
    let isolated_pool = sqlx::postgres::PgPoolOptions::new()
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    let server = Server::start(crate::app(AppState {
        pool: isolated_pool.clone(),
        session_changes: crate::auth::SessionChanges::with_recheck_timing(
            Duration::from_millis(200),
            Duration::from_millis(100),
        ),
        ..f.state.clone()
    }))
    .await;
    let mut socket = server.connect(&f.token).await;
    subscribe(&mut socket, f.channel, 0).await;
    ready(&mut socket, f.channel, 0).await;
    isolated_pool.close().await;
    fallback_close(&mut socket, 1011).await;
    // A DB check error must never masquerade as a revoked session.
    let mut reconnect = f.server.connect(&f.token).await;
    subscribe(&mut reconnect, f.channel, 0).await;
    ready(&mut reconnect, f.channel, 0).await;
}
