use super::session::{
    account_id, add_organization_membership, another_session, connect_organization, fallback_close,
};
use super::*;
use axum::extract::ConnectInfo;

const PASSWORD: &str = "correct horse battery staple";
const OPERATIONS: [(&str, &str); 2] = [
    ("PUT", "/api/v1/me/password"),
    ("POST", "/api/v1/me/sessions/revoke-others"),
];

async fn security_request(app: &Router, operation: usize, token: &str, correct: bool) -> Response {
    let (method, path) = OPERATIONS[operation];
    let mut body = json!({"current_password":if correct {PASSWORD} else {"wrong password"}});
    if operation == 0 {
        body["new_password"] = json!("new correct horse battery staple");
    }
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .extension(ConnectInfo(
                    "192.0.2.1:1234".parse::<std::net::SocketAddr>().unwrap(),
                ))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn post_foreign(f: &Fixture, organization: Uuid, channel: Uuid, body: &str) -> Value {
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{organization}/channels/{channel}/messages"),
        &f.token,
        json!({"client_message_id":Uuid::new_v4(),"body":body}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap()
}

async fn account_sockets(pool: PgPool, operation: usize, cancel: bool) {
    let f = fixture(&pool).await;
    let account = account_id(&pool, f.organization, f.member).await;
    crate::auth::security::test_support::set_password(&pool, account, PASSWORD).await;
    let foreign = organization(&pool).await;
    let foreign_member = add_organization_membership(&pool, foreign, account).await;
    let foreign_channel = channel(&pool, foreign, foreign_member, true).await;
    let (_, unrelated) = member(&pool, f.organization).await;
    let cookie = another_session(&pool, f.organization, f.member).await;
    let bearer = another_session(&pool, f.organization, f.member).await;
    let mut current = f.server.connect(&f.token).await;
    let mut current_foreign = connect_organization(&f.server, &f.token, foreign).await;
    let mut idle = f
        .server
        .handshake(
            None,
            Some(&cookie),
            Some(&format!("http://{}", f.server.address)),
        )
        .await
        .unwrap();
    let mut replay = f.server.connect(&bearer).await;
    let mut foreign_socket = connect_organization(&f.server, &bearer, foreign).await;
    let mut other = f.server.connect(&unrelated).await;
    for socket in [&mut current, &mut idle, &mut other] {
        subscribe(socket, f.channel, 0).await;
        ready(socket, f.channel, 0).await;
    }
    for socket in [&mut current_foreign, &mut foreign_socket] {
        subscribe(socket, foreign_channel, 0).await;
        ready(socket, foreign_channel, 0).await;
    }
    // Every denial preserves all sockets, including the current Session in both Organizations.
    let denied = security_request(&f.app, operation, &f.token, false).await;
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    let bytes = to_bytes(denied.into_body(), 1024).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap(),
        json!({"error":"current_password_incorrect"})
    );
    let canonical = post(&f, f.channel).await;
    for socket in [&mut current, &mut idle, &mut other] {
        assert_eq!(event(socket).await["message"], canonical);
    }
    let foreign_message = post_foreign(&f, foreign, foreign_channel, "current Session in B").await;
    for socket in [&mut current_foreign, &mut foreign_socket] {
        assert_eq!(event(socket).await["message"], foreign_message);
    }
    let gate = pause(f.channel);
    subscribe(&mut replay, f.channel, 0).await;
    entered(&gate).await;
    let mut blocker = pool.begin().await.unwrap();
    crate::auth::security::test_support::lock_account(&mut blocker, account).await;
    let pending = {
        let app = f.app.clone();
        let token = f.token.clone();
        tokio::spawn(async move { security_request(&app, operation, &token, true).await })
    };
    tokio::time::timeout(Duration::from_secs(10),async {loop {
        let waiting:bool=sqlx::query_scalar("SELECT EXISTS (SELECT FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT password_hash FROM accounts%FOR UPDATE')").fetch_one(&pool).await.unwrap();
        if waiting {break;} tokio::task::yield_now().await;
    }}).await.unwrap();
    if cancel {
        pending.abort();
    }
    blocker.commit().await.unwrap();
    if !cancel {
        assert_eq!(pending.await.unwrap().status(), StatusCode::NO_CONTENT);
    }
    tokio::join!(
        fallback_close(&mut idle, CLOSE_SESSION_ENDED),
        fallback_close(&mut replay, CLOSE_SESSION_ENDED),
        fallback_close(&mut foreign_socket, CLOSE_SESSION_ENDED)
    );
    let canonical = post(&f, f.channel).await;
    assert_eq!(event(&mut current).await["message"], canonical);
    assert_eq!(event(&mut other).await["message"], canonical);
    let canonical = post_foreign(
        &f,
        foreign,
        foreign_channel,
        "current Session survives in B",
    )
    .await;
    assert_eq!(event(&mut current_foreign).await["message"], canonical);
    for token in [&cookie, &bearer] {
        for use_cookie in [false, true] {
            let (auth, cookie) = if use_cookie {
                (None, Some(token.as_str()))
            } else {
                (Some(token.as_str()), None)
            };
            let denied = f
                .server
                .handshake(auth, cookie, Some(&format!("http://{}", f.server.address)))
                .await;
            let Err(tungstenite::Error::Http(response)) = denied else {
                panic!("revoked credential admitted")
            };
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        assert_eq!(
            request(&f.app, "GET", "/api/v1/me", token, Value::Null)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        request(&f.app, "GET", "/api/v1/me", &unrelated, Value::Null)
            .await
            .status(),
        StatusCode::OK
    );
}

#[fukulow_test::test]
async fn password_change_closes_other_cookie_bearer_idle_and_replaying_sockets_only(pool: PgPool) {
    account_sockets(pool, 0, false).await;
}
#[fukulow_test::test]
async fn revoke_others_closes_other_cookie_bearer_idle_and_replaying_sockets_only(pool: PgPool) {
    account_sockets(pool, 1, false).await;
}
#[fukulow_test::test]
async fn password_change_http_cancellation_finishes_commit_and_all_signals(pool: PgPool) {
    account_sockets(pool, 0, true).await;
}
#[fukulow_test::test]
async fn revoke_others_http_cancellation_finishes_commit_and_all_signals(pool: PgPool) {
    account_sockets(pool, 1, true).await;
}
