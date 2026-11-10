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
    sqlx::query("INSERT INTO account_sessions (token_hash, account_id) SELECT $2, account_id FROM users WHERE organization_id = $1 AND id = $3")
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
    let changes = crate::auth::SessionChanges::with_recheck_timing(
        Duration::from_millis(50),
        Duration::from_millis(500),
    );
    let fallback = changes.pause_fallback();
    let server = Server::start(crate::app(AppState {
        session_changes: changes,
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
    fallback.entered().await;
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
    // The first fallback pass cannot run until this barrier releases; the sign-out
    // used an isolated registry and the sessions have not reached their expiry.
    fallback.release();
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

#[sqlx::test]
async fn worker_panic_closes_existing_and_new_sockets_with_internal_error(pool: PgPool) {
    let f = fixture(&pool).await;
    let changes = crate::auth::SessionChanges::with_recheck_timing(
        Duration::from_millis(50),
        Duration::from_secs(1),
    )
    .with_on_fatal(std::sync::Arc::new(|| {}));
    let server = Server::start(crate::app(AppState {
        session_changes: changes.clone(),
        ..f.state.clone()
    }))
    .await;
    let mut idle = server.connect(&f.token).await;
    subscribe(&mut idle, f.channel, 0).await;
    ready(&mut idle, f.channel, 0).await;
    let mut replay = server.connect(&f.token).await;
    let gate = pause(f.channel);
    subscribe(&mut replay, f.channel, 0).await;
    entered(&gate).await;
    tokio::time::timeout(Duration::from_secs(3), changes.panic_worker())
        .await
        .unwrap();
    tokio::join!(
        fallback_close(&mut idle, 1011),
        fallback_close(&mut replay, 1011)
    );
    // The DB session remains valid, but no normal subscription is admitted.
    for _ in 0..2 {
        let mut new = server.connect(&f.token).await;
        fallback_close(&mut new, 1011).await;
    }
    let mut healthy = f.server.connect(&f.token).await;
    subscribe(&mut healthy, f.channel, 0).await;
    ready(&mut healthy, f.channel, 0).await;
}

async fn account_id(pool: &PgPool, organization: Uuid, member: Uuid) -> Uuid {
    sqlx::query_scalar("SELECT account_id FROM users WHERE organization_id=$1 AND id=$2")
        .bind(organization)
        .bind(member)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn add_organization_membership(pool: &PgPool, organization: Uuid, account: Uuid) -> Uuid {
    let member = Uuid::new_v4();
    sqlx::query("INSERT INTO users (organization_id,id,account_id,name,role) VALUES ($1,$2,$3,'Independent Member','guest')")
        .bind(organization).bind(member).bind(account).execute(pool).await.unwrap();
    member
}

async fn connect_organization(server: &Server, token: &str, organization: Uuid) -> Client {
    let mut request = format!("ws://{}/api/v1/orgs/{organization}/ws", server.address)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    tokio_tungstenite::connect_async(request).await.unwrap().0
}

#[sqlx::test]
async fn membership_loss_closes_all_account_sessions_only_in_its_organization(pool: PgPool) {
    let f = fixture(&pool).await;
    let account = account_id(&pool, f.organization, f.member).await;
    let foreign = organization(&pool).await;
    let foreign_member = add_organization_membership(&pool, foreign, account).await;
    let foreign_channel = channel(&pool, foreign, foreign_member, false).await;
    let second = another_session(&pool, f.organization, f.member).await;
    let mut a1 = f.server.connect(&f.token).await;
    let mut a2 = f.server.connect(&second).await;
    let mut b1 = connect_organization(&f.server, &f.token, foreign).await;
    let mut b2 = connect_organization(&f.server, &second, foreign).await;
    for socket in [&mut a1, &mut a2] {
        subscribe(socket, f.channel, 0).await;
        ready(socket, f.channel, 0).await;
    }
    for socket in [&mut b1, &mut b2] {
        subscribe(socket, foreign_channel, 0).await;
        ready(socket, foreign_channel, 0).await;
    }
    crate::auth::deactivate_member(&f.state, f.organization, account)
        .await
        .unwrap();
    tokio::join!(
        fallback_close(&mut a1, CLOSE_ORGANIZATION_UNAVAILABLE),
        fallback_close(&mut a2, CLOSE_ORGANIZATION_UNAVAILABLE)
    );
    // A public subscription has closed, while both Sessions still deliver in B.
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{foreign}/channels/{foreign_channel}/messages"),
        &f.token,
        json!({"client_message_id":Uuid::new_v4(),"body":"B survives"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let canonical: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap();
    assert_eq!(event(&mut b1).await["message"], canonical);
    assert_eq!(event(&mut b2).await["message"], canonical);
    for suffix in [
        "me".to_owned(),
        "channels".into(),
        format!("channels/{}/messages?after_seq=0", f.channel),
    ] {
        assert_eq!(
            request(
                &f.app,
                "GET",
                &format!("/api/v1/orgs/{}/{suffix}", f.organization),
                &f.token,
                Value::Null
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
    }
    rejected(f.server.handshake(Some(&f.token), None, None).await, 404);
}

#[sqlx::test]
async fn account_session_end_closes_every_organization_but_leaves_other_sessions_usable(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let account = account_id(&pool, f.organization, f.member).await;
    let foreign = organization(&pool).await;
    let foreign_member = add_organization_membership(&pool, foreign, account).await;
    let foreign_channel = channel(&pool, foreign, foreign_member, false).await;
    let second = another_session(&pool, f.organization, f.member).await;
    let mut a1 = f.server.connect(&f.token).await;
    let mut b1 = connect_organization(&f.server, &f.token, foreign).await;
    let mut a2 = f.server.connect(&second).await;
    let mut b2 = connect_organization(&f.server, &second, foreign).await;
    for socket in [&mut a1, &mut a2] {
        subscribe(socket, f.channel, 0).await;
        ready(socket, f.channel, 0).await;
    }
    for socket in [&mut b1, &mut b2] {
        subscribe(socket, foreign_channel, 0).await;
        ready(socket, foreign_channel, 0).await;
    }
    assert_eq!(
        request(&f.app, "DELETE", "/api/v1/session", &f.token, Value::Null)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    tokio::join!(
        fallback_close(&mut a1, CLOSE_SESSION_ENDED),
        fallback_close(&mut b1, CLOSE_SESSION_ENDED)
    );
    let canonical = send(&f, &second, f.channel, Uuid::new_v4(), "A second Session").await;
    assert_eq!(event(&mut a2).await["message"], canonical);
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{foreign}/channels/{foreign_channel}/messages"),
        &second,
        json!({"client_message_id":Uuid::new_v4(),"body":"B second Session"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let canonical: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap();
    assert_eq!(event(&mut b2).await["message"], canonical);
}

#[sqlx::test]
async fn lost_membership_signal_and_reactivation_still_close_stale_idle_and_replaying_sockets(
    pool: PgPool,
) {
    for reactivate in [false, true] {
        let f = fixture(&pool).await;
        let changes = crate::auth::SessionChanges::with_recheck_timing(
            Duration::from_millis(50),
            Duration::from_millis(500),
        );
        let fallback = changes.pause_fallback();
        let server = Server::start(crate::app(AppState {
            session_changes: changes,
            ..f.state.clone()
        }))
        .await;
        let mut idle = server.connect(&f.token).await;
        subscribe(&mut idle, f.channel, 0).await;
        ready(&mut idle, f.channel, 0).await;
        let mut replay = server.connect(&f.token).await;
        let gate = pause(f.channel);
        subscribe(&mut replay, f.channel, 0).await;
        entered(&gate).await;
        fallback.entered().await;
        let started = tokio::time::Instant::now();
        // Direct SQL deliberately drops the process signal; the DB trigger records the epoch.
        sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
            .bind(f.organization)
            .bind(f.member)
            .execute(&pool)
            .await
            .unwrap();
        if reactivate {
            sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
                .bind(f.organization)
                .bind(f.member)
                .execute(&pool)
                .await
                .unwrap();
        }
        fallback.release();
        tokio::join!(
            fallback_close(&mut idle, CLOSE_ORGANIZATION_UNAVAILABLE),
            fallback_close(&mut replay, CLOSE_ORGANIZATION_UNAVAILABLE)
        );
        assert!(started.elapsed() < Duration::from_secs(3));
        gate.release.add_permits(1);
        if reactivate {
            let mut current = server.connect(&f.token).await;
            subscribe(&mut current, f.channel, 0).await;
            ready(&mut current, f.channel, 0).await;
            let canonical = post(&f, f.channel).await;
            assert_eq!(event(&mut current).await["message"], canonical);
        }
    }
}

#[sqlx::test]
async fn websocket_organization_denials_are_identical_for_nonmember_unknown_and_inactive(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let foreign = organization(&pool).await;
    let mut expected = None;
    for organization in [foreign, Uuid::new_v4(), f.organization] {
        if organization == f.organization {
            sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1")
                .bind(organization)
                .execute(&pool)
                .await
                .unwrap();
        }
        let mut request = format!("ws://{}/api/v1/orgs/{organization}/ws", f.server.address)
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            header::AUTHORIZATION,
            format!("Bearer {}", f.token).parse().unwrap(),
        );
        let Err(tungstenite::Error::Http(response)) =
            tokio_tungstenite::connect_async(request).await
        else {
            panic!("expected Organization refusal")
        };
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body: Value = serde_json::from_slice(response.body().as_ref().unwrap()).unwrap();
        assert_eq!(body, json!({"error":"organization_unavailable"}));
        if let Some(expected) = &expected {
            assert_eq!(&body, expected);
        } else {
            expected = Some(body);
        }
    }
}
