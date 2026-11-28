use super::{AppState, Budget, SocketGate, SocketLimits, Uuid, socket_client::Client};
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
    response::Response,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};
use tower::ServiceExt;

const UNMETERED: Budget = Budget {
    burst: 1 << 40,
    per_second: 1,
};

pub(super) struct Server {
    pub(super) address: std::net::SocketAddr,
    pub(super) task: JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    pub(super) async fn start(router: Router) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self { address, task }
    }
    pub(super) async fn connect(&self, token: &str) -> Client {
        self.handshake(Some(token), None, None).await.unwrap()
    }
    pub(super) async fn handshake(
        &self,
        bearer: Option<&str>,
        cookie: Option<&str>,
        origin: Option<&str>,
    ) -> Result<Client, tungstenite::Error> {
        let mut request = format!(
            "ws://{}{}",
            self.address,
            bearer
                .or(cookie)
                .filter(|token| token.contains('.'))
                .map(|token| scoped_path("/api/v1/ws", token))
                .unwrap_or_else(|| format!("/api/v1/orgs/{}/ws", Uuid::nil()))
        )
        .into_client_request()
        .unwrap();
        if let Some(token) = bearer {
            request.headers_mut().insert(
                header::AUTHORIZATION,
                format!("Bearer {token}").parse().unwrap(),
            );
        }
        if let Some(token) = cookie {
            request.headers_mut().insert(
                header::COOKIE,
                format!("fukulow_session={token}").parse().unwrap(),
            );
        }
        if let Some(origin) = origin {
            request
                .headers_mut()
                .insert(header::ORIGIN, origin.parse().unwrap());
        }
        tokio_tungstenite::connect_async(request)
            .await
            .map(|(client, _)| client)
    }
}
pub(super) async fn state(pool: &PgPool) -> AppState {
    state_with_test_pool(crate::test_app_pool(pool.clone()).await)
}

/// `state` over `pool` as given (e.g. a pool that never connects).
pub(super) fn state_with_test_pool(pool: PgPool) -> AppState {
    AppState {
        pool,
        cookie_secure: false,
        setup_token: "setup-token-test-only".into(),
        sign_in_throttle: Default::default(),
        account_security_throttle: Default::default(),
        message_delivery: Default::default(),
        session_changes: Default::default(),
        session_cleanup: Default::default(),
        shutdown: Default::default(),
        ws_allowed_origins: Default::default(),
        // Caps and budgets are exercised in tests/limits.rs; other tests and the
        // manual measurements open many sockets and subscriptions for one Account.
        socket_gate: SocketGate::new(SocketLimits {
            per_account: 100_000,
            global: 100_000,
            connection_frames: UNMETERED,
            account_frames: UNMETERED,
            ..SocketLimits::default()
        }),
    }
}
pub(super) struct Fixture {
    pub(super) app: Router,
    pub(super) server: Server,
    pub(super) state: AppState,
    pub(super) organization: Uuid,
    pub(super) member: Uuid,
    pub(super) channel: Uuid,
    pub(super) token: String,
}
pub(super) async fn organization(pool: &PgPool) -> Uuid {
    let organization = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (organization_id, name) VALUES ($1, 'Organization')")
        .bind(organization)
        .execute(pool)
        .await
        .unwrap();
    organization
}
pub(super) async fn member(pool: &PgPool, organization_id: Uuid) -> (Uuid, String) {
    let id = Uuid::new_v4();
    let account_id = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, email, password_hash) VALUES ($1, $2, 'unused')")
        .bind(account_id)
        .bind(format!("{account_id}@example.com"))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (organization_id, id, account_id, name, role) VALUES ($1, $2, $3, 'Member', $4)")
        .bind(organization_id).bind(id).bind(account_id).bind("member").execute(pool).await.unwrap();
    // The prefix is fixture metadata for explicit Organization route construction.
    let token = format!(
        "{organization_id}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    sqlx::query("INSERT INTO account_sessions (token_hash, account_id) VALUES ($1, $2)")
        .bind(Sha256::digest(token.as_bytes()).to_vec())
        .bind(account_id)
        .execute(pool)
        .await
        .unwrap();
    (id, token)
}

pub(super) async fn channel(
    pool: &PgPool,
    organization: Uuid,
    member: Uuid,
    private: bool,
) -> Uuid {
    let channel = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels (organization_id, id, name, visibility) VALUES ($1, $2, $3, $4)",
    )
    .bind(organization)
    .bind(channel)
    .bind(format!("Channel {channel}"))
    .bind(if private { "private" } else { "public" })
    .execute(pool)
    .await
    .unwrap();
    if private {
        sqlx::query("INSERT INTO channel_members (organization_id, channel_id, member_id) VALUES ($1, $2, $3)")
            .bind(organization).bind(channel).bind(member).execute(pool).await.unwrap();
    }
    channel
}
pub(super) async fn fixture(pool: &PgPool) -> Fixture {
    fixture_with_app_pool(pool, pool).await
}
pub(super) async fn fixture_with_configured_pool(pool: &PgPool, size: &str) -> Fixture {
    let restricted = crate::test_app_pool(pool.clone()).await;
    let configured = crate::database::PoolConfig::configured(Some(size), None)
        .unwrap()
        .connect_with(restricted.connect_options().as_ref().clone())
        .await
        .unwrap();
    fixture_with_app_pool(pool, &configured).await
}
pub(super) async fn fixture_with_app_pool(admin: &PgPool, app_pool: &PgPool) -> Fixture {
    let organization = organization(admin).await;
    let (member, token) = member(admin, organization).await;
    let channel = channel(admin, organization, member, false).await;
    let state = state(app_pool).await;
    let app = crate::app(state.clone(), Default::default());
    let server = Server::start(app.clone()).await;
    Fixture {
        app,
        server,
        state,
        organization,
        member,
        channel,
        token,
    }
}
pub(super) async fn request(
    app: &Router,
    method: &str,
    path: &str,
    token: &str,
    input: Value,
) -> Response {
    let path = scoped_path(path, token);
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(&path)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(input.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}
pub(super) async fn send(f: &Fixture, token: &str, channel: Uuid, key: Uuid, body: &str) -> Value {
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/channels/{channel}/messages"),
        token,
        json!({"client_message_id":key,"body":body}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    serde_json::from_slice(&to_bytes(response.into_body(), 32 * 1024).await.unwrap()).unwrap()
}
pub(super) async fn post(f: &Fixture, channel: Uuid) -> Value {
    send(f, &f.token, channel, Uuid::new_v4(), "hello").await
}
pub(super) fn scoped_path(path: &str, token: &str) -> String {
    if path.starts_with("/api/v1/channels") || path.starts_with("/api/v1/ws") {
        let organization = token
            .split_once('.')
            .map(|(id, _)| id)
            .expect("test token must carry its Organization scope");
        path.replacen("/api/v1/", &format!("/api/v1/orgs/{organization}/"), 1)
    } else {
        path.to_owned()
    }
}
