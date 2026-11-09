use super::*;
use crate::messages;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::Request,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::sync::{Arc, LazyLock, Mutex};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::JoinHandle,
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{self, client::IntoClientRequest},
};
use tower::ServiceExt;

type Client = WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

// Test-only pause after registration and the history snapshot, before replay/handoff.
struct Gate {
    entered: Semaphore,
    release: Semaphore,
}
static GATES: LazyLock<Mutex<HashMap<Uuid, Arc<Gate>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
fn pause(channel: Uuid) -> Arc<Gate> {
    let gate = Arc::new(Gate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    GATES.lock().unwrap().insert(channel, gate.clone());
    gate
}
pub(super) async fn replay_gate(channel: Uuid) {
    let gate = GATES.lock().unwrap().remove(&channel);
    if let Some(gate) = gate {
        gate.entered.add_permits(1);
        gate.release.acquire().await.unwrap().forget();
    }
}
async fn entered(gate: &Gate) {
    tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
}

struct Server {
    address: std::net::SocketAddr,
    task: JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    async fn start(router: Router) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self { address, task }
    }
    async fn connect(&self, token: &str) -> Client {
        self.handshake(Some(token), None, None).await.unwrap()
    }
    async fn handshake(
        &self,
        bearer: Option<&str>,
        cookie: Option<&str>,
        origin: Option<&str>,
    ) -> Result<Client, tungstenite::Error> {
        let mut request = format!("ws://{}/api/v1/ws", self.address)
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
fn state(pool: &PgPool) -> AppState {
    AppState {
        pool: pool.clone(),
        cookie_secure: false,
        setup_token: None,
        sign_in_throttle: Default::default(),
        message_delivery: Default::default(),
        session_changes: Default::default(),
        session_cleanup: Default::default(),
        ws_allowed_origins: Default::default(),
    }
}
struct Fixture {
    app: Router,
    server: Server,
    state: AppState,
    organization: Uuid,
    member: Uuid,
    channel: Uuid,
    token: String,
}
async fn organization(pool: &PgPool) -> Uuid {
    let organization = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (organization_id, name) VALUES ($1, 'Organization')")
        .bind(organization)
        .execute(pool)
        .await
        .unwrap();
    organization
}
async fn member(pool: &PgPool, organization: Uuid) -> (Uuid, String) {
    let member = Uuid::new_v4();
    sqlx::query("INSERT INTO users (organization_id, id, email, name, password_hash, role) VALUES ($1, $2, $3, 'Member', 'unused', 'member')")
        .bind(organization).bind(member).bind(format!("{member}@example.com")).execute(pool).await.unwrap();
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
    (member, token)
}
async fn channel(pool: &PgPool, organization: Uuid, member: Uuid, private: bool) -> Uuid {
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
async fn fixture(pool: &PgPool) -> Fixture {
    let organization = organization(pool).await;
    let (member, token) = member(pool, organization).await;
    let channel = channel(pool, organization, member, false).await;
    let state = state(pool);
    let app = crate::app(state.clone());
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
async fn request(app: &Router, method: &str, path: &str, token: &str, input: Value) -> Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(input.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn send(f: &Fixture, token: &str, channel: Uuid, key: Uuid, body: &str) -> Value {
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
async fn post(f: &Fixture, channel: Uuid) -> Value {
    send(f, &f.token, channel, Uuid::new_v4(), "hello").await
}
async fn control(
    client: &mut (impl futures_util::Sink<tungstenite::Message, Error = tungstenite::Error> + Unpin),
    control: ClientMessage,
) -> Result<(), tungstenite::Error> {
    client
        .send(tungstenite::Message::text(
            serde_json::to_string(&control).unwrap(),
        ))
        .await
}
async fn subscribe(client: &mut Client, channel: Uuid, after: i64) {
    control(
        client,
        ClientMessage::Subscribe {
            channel_id: channel,
            after_seq: after,
        },
    )
    .await
    .unwrap();
}
async fn frame(client: &mut Client) -> tungstenite::Message {
    tokio::time::timeout(Duration::from_secs(5), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}
async fn event(client: &mut Client) -> Value {
    serde_json::from_str(frame(client).await.to_text().unwrap()).unwrap()
}
async fn ready(client: &mut Client, channel: Uuid, seq: i64) {
    assert_eq!(
        event(client).await,
        json!({"type":"subscribed", "channel_id":channel, "caught_up_seq":seq})
    );
}
async fn denied(client: &mut Client, channel: Uuid) {
    assert_eq!(
        event(client).await,
        json!({"type":"error", "channel_id":channel, "code":"channel_not_found"})
    );
}
async fn silent(client: &mut Client) {
    assert!(
        tokio::time::timeout(Duration::from_millis(100), client.next())
            .await
            .is_err()
    );
}
async fn closed(client: &mut Client, code: u16) {
    let tungstenite::Message::Close(Some(close)) = frame(client).await else {
        panic!("expected close");
    };
    assert_eq!(u16::from(close.code), code);
}
fn rejected(result: Result<Client, tungstenite::Error>, status: u16) {
    let Err(tungstenite::Error::Http(response)) = result else {
        panic!("expected HTTP denial");
    };
    assert_eq!(response.status(), status);
    let body: Value = serde_json::from_slice(response.body().as_ref().unwrap()).unwrap();
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn unauthenticated_websocket_upgrade_rejects_cookie_bearer_and_query_tokens_without_database()
{
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let router = crate::app(state(&pool));
    for path in ["/api/v1/ws", "/api/v1/ws?token=ignored"] {
        for authorization in [None, Some("Bearer invalid"), Some("Basic invalid")] {
            let mut builder = Request::get(path);
            if let Some(value) = authorization {
                builder = builder.header(header::AUTHORIZATION, value);
            }
            let response = router
                .clone()
                .oneshot(builder.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
    }
}

#[sqlx::test]
async fn invalid_websocket_upgrade_with_authenticated_cookie_and_allowed_origin_returns_400(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let mut request = format!("ws://{}/api/v1/ws", f.server.address)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        header::COOKIE,
        format!("fukulow_session={}", f.token).parse().unwrap(),
    );
    request.headers_mut().insert(
        header::ORIGIN,
        format!("http://{}", f.server.address).parse().unwrap(),
    );
    // Keep the client's required headers present so the malformed handshake reaches the server.
    request
        .headers_mut()
        .insert(header::SEC_WEBSOCKET_VERSION, "12".parse().unwrap());
    let Err(tungstenite::Error::Http(response)) = tokio_tungstenite::connect_async(request).await
    else {
        panic!("expected HTTP 400 for invalid upgrade");
    };
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let body: Value = serde_json::from_slice(response.body().as_ref().unwrap()).unwrap();
    assert_eq!(body, json!({"error": "invalid websocket upgrade"}));
    // The same credential and Origin upgrade successfully with valid headers.
    f.server
        .handshake(
            None,
            Some(&f.token),
            Some(&format!("http://{}", f.server.address)),
        )
        .await
        .unwrap();
}

#[sqlx::test]
async fn websocket_handshake_enforces_cookie_origin_and_accepts_native_bearer(pool: PgPool) {
    let f = fixture(&pool).await;
    rejected(f.server.handshake(None, None, None).await, 401);
    let query_url = format!("ws://{}/api/v1/ws?token={}", f.server.address, f.token);
    rejected(
        tokio_tungstenite::connect_async(query_url)
            .await
            .map(|(client, _)| client),
        401,
    );
    let invalid_upgrade = request(&f.app, "GET", "/api/v1/ws", &f.token, Value::Null).await;
    assert_eq!(invalid_upgrade.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        invalid_upgrade.headers()[header::CONTENT_TYPE],
        "application/json"
    );
    rejected(
        f.server
            .handshake(None, Some(&f.token), Some("https://foreign.example"))
            .await,
        403,
    );
    rejected(f.server.handshake(None, Some(&f.token), None).await, 403);
    let own = format!("http://{}", f.server.address);
    let mut cookie = f
        .server
        .handshake(None, Some(&f.token), Some(&own))
        .await
        .unwrap();
    subscribe(&mut cookie, f.channel, 0).await;
    ready(&mut cookie, f.channel, 0).await;
    let mut bearer = f.server.connect(&f.token).await;
    subscribe(&mut bearer, f.channel, 0).await;
    ready(&mut bearer, f.channel, 0).await;
    rejected(
        f.server
            .handshake(Some("invalid"), Some(&f.token), Some(&own))
            .await,
        401,
    );
    sqlx::query(
        "UPDATE sessions SET expires_at = now() - interval '1 second' WHERE organization_id = $1",
    )
    .bind(f.organization)
    .execute(&pool)
    .await
    .unwrap();
    rejected(f.server.handshake(Some(&f.token), None, None).await, 401);
}

#[sqlx::test]
async fn live_delivery_denies_other_organization_and_private_nonmember_with_positive_controls(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    let (_, nonmember_token) = member(&pool, f.organization).await;
    let other = organization(&pool).await;
    let (other_member, other_token) = member(&pool, other).await;
    let other_public = channel(&pool, other, other_member, false).await;
    let mut authorized = f.server.connect(&f.token).await;
    let mut nonmember = f.server.connect(&nonmember_token).await;
    let mut foreign = f.server.connect(&other_token).await;
    subscribe(&mut authorized, private, 0).await;
    ready(&mut authorized, private, 0).await;
    subscribe(&mut nonmember, private, 0).await;
    denied(&mut nonmember, private).await;
    subscribe(&mut foreign, private, 0).await;
    denied(&mut foreign, private).await;
    subscribe(&mut foreign, f.channel, 0).await;
    denied(&mut foreign, f.channel).await;
    subscribe(&mut nonmember, f.channel, 0).await;
    ready(&mut nonmember, f.channel, 0).await;
    subscribe(&mut foreign, other_public, 0).await;
    ready(&mut foreign, other_public, 0).await;
    let secret = post(&f, private).await;
    assert_eq!(
        event(&mut authorized).await,
        json!({"type":"message","message":secret})
    );
    let public = post(&f, f.channel).await;
    assert_eq!(event(&mut nonmember).await["message"], public);
    let own = send(
        &f,
        &other_token,
        other_public,
        Uuid::new_v4(),
        "own organization",
    )
    .await;
    assert_eq!(event(&mut foreign).await["message"], own);
    silent(&mut nonmember).await;
    silent(&mut foreign).await;
    control(
        &mut authorized,
        ClientMessage::Unsubscribe {
            channel_id: private,
        },
    )
    .await
    .unwrap();
    // A control response acts as a barrier for the unsubscribe.
    subscribe(&mut authorized, f.channel, 1).await;
    ready(&mut authorized, f.channel, 1).await;
    post(&f, private).await;
    silent(&mut authorized).await;
}

#[sqlx::test]
async fn replay_denies_other_organization_and_private_nonmember_with_positive_controls(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    let secret = post(&f, private).await;
    let public = post(&f, f.channel).await;
    let (_, nonmember) = member(&pool, f.organization).await;
    let other = organization(&pool).await;
    let (foreign_member, foreign) = member(&pool, other).await;
    let foreign_channel = channel(&pool, other, foreign_member, false).await;
    let own = send(&f, &foreign, foreign_channel, Uuid::new_v4(), "own history").await;
    for token in [&nonmember, &foreign] {
        let mut socket = f.server.connect(token).await;
        subscribe(&mut socket, private, 0).await;
        denied(&mut socket, private).await;
        if token == &foreign {
            subscribe(&mut socket, f.channel, 0).await;
            denied(&mut socket, f.channel).await;
            subscribe(&mut socket, foreign_channel, 0).await;
            assert_eq!(event(&mut socket).await["message"], own);
            ready(&mut socket, foreign_channel, 1).await;
        } else {
            subscribe(&mut socket, f.channel, 0).await;
            assert_eq!(event(&mut socket).await["message"], public);
            ready(&mut socket, f.channel, 1).await;
        }
        silent(&mut socket).await;
    }
    let mut owner = f.server.connect(&f.token).await;
    subscribe(&mut owner, private, 0).await;
    assert_eq!(event(&mut owner).await["message"], secret);
    ready(&mut owner, private, 1).await;
}

#[sqlx::test]
async fn replay_pages_handoff_and_reconnect_keep_independent_channel_sequences_without_gaps(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let second = channel(&pool, f.organization, f.member, false).await;
    for _ in 0..120 {
        post(&f, f.channel).await;
    }
    for _ in 0..9 {
        post(&f, second).await;
    }
    let mut socket = f.server.connect(&f.token).await;
    let gate = pause(f.channel);
    subscribe(&mut socket, f.channel, 7).await;
    entered(&gate).await;
    // These commit after the history high-water mark and must survive the handoff.
    for _ in 0..5 {
        post(&f, f.channel).await;
    }
    gate.release.add_permits(1);
    for seq in 8..=125 {
        let value = event(&mut socket).await;
        assert_eq!(value["type"], "message");
        assert_eq!(value["message"]["channel_id"], json!(f.channel));
        assert_eq!(value["message"]["seq"], seq);
    }
    ready(&mut socket, f.channel, 125).await;
    subscribe(&mut socket, second, 4).await;
    for seq in 5..=9 {
        assert_eq!(event(&mut socket).await["message"]["seq"], seq);
    }
    ready(&mut socket, second, 9).await;
    drop(socket);
    post(&f, f.channel).await;
    post(&f, second).await;
    let mut reconnect = f.server.connect(&f.token).await;
    for (channel, last, next) in [(f.channel, 125, 126), (second, 9, 10)] {
        subscribe(&mut reconnect, channel, last).await;
        let replay = event(&mut reconnect).await;
        assert_eq!(replay["message"]["channel_id"], json!(channel));
        assert_eq!(replay["message"]["seq"], next);
        ready(&mut reconnect, channel, next).await;
    }
    silent(&mut reconnect).await;
}

#[sqlx::test]
async fn rollback_and_idempotent_retry_emit_no_notification_and_publish_sees_committed_rows(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let mut queue = f.state.message_delivery.queue(f.organization, f.member, 8);
    queue.subscribe(f.channel);
    sqlx::raw_sql("CREATE FUNCTION fail_realtime_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.body = 'rollback' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER fail_realtime_insert AFTER INSERT ON messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_realtime_insert();").execute(&pool).await.unwrap();
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/channels/{}/messages", f.channel),
        &f.token,
        json!({"client_message_id":Uuid::new_v4(),"body":"rollback"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(queue.events.try_recv().is_err());
    let key = Uuid::new_v4();
    let canonical = send(&f, &f.token, f.channel, key, "committed").await;
    assert_eq!(queue.events.recv().await.unwrap().channel_id, f.channel);
    let stored = messages::replay_page(&pool, f.organization, f.channel, 0, 1)
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(&stored[0]).unwrap(), canonical);
    assert_eq!(
        send(&f, &f.token, f.channel, key, "committed").await,
        canonical
    );
    assert!(queue.events.try_recv().is_err());
    let mut socket = f.server.connect(&f.token).await;
    subscribe(&mut socket, f.channel, 1).await;
    ready(&mut socket, f.channel, 1).await;
    send(&f, &f.token, f.channel, key, "committed").await;
    silent(&mut socket).await;
}

#[sqlx::test]
async fn overflow_closes_socket_and_reconnect_replays_every_committed_message(pool: PgPool) {
    let f = fixture(&pool).await;
    post(&f, f.channel).await;
    let mut socket = f.server.connect(&f.token).await;
    let gate = pause(f.channel);
    subscribe(&mut socket, f.channel, 0).await;
    entered(&gate).await;
    for _ in 0..257 {
        post(&f, f.channel).await;
    }
    closed(&mut socket, CLOSE_QUEUE_OVERFLOW).await;
    let mut reconnect = f.server.connect(&f.token).await;
    subscribe(&mut reconnect, f.channel, 0).await;
    for seq in 1..=258 {
        assert_eq!(event(&mut reconnect).await["message"]["seq"], seq);
    }
    ready(&mut reconnect, f.channel, 258).await;
}

#[sqlx::test]
async fn sign_out_closes_idle_and_replaying_sockets_but_leaves_other_sessions_usable(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_, other_token) = member(&pool, f.organization).await;
    let mut idle = f.server.connect(&f.token).await;
    subscribe(&mut idle, f.channel, 0).await;
    ready(&mut idle, f.channel, 0).await;
    let mut replay = f.server.connect(&f.token).await;
    let gate = pause(f.channel);
    subscribe(&mut replay, f.channel, 0).await;
    entered(&gate).await;
    let mut other = f.server.connect(&other_token).await;
    subscribe(&mut other, f.channel, 0).await;
    ready(&mut other, f.channel, 0).await;
    assert_eq!(
        request(&f.app, "DELETE", "/api/v1/session", &f.token, Value::Null)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    closed(&mut idle, CLOSE_SESSION_ENDED).await;
    closed(&mut replay, CLOSE_SESSION_ENDED).await;
    let own = send(
        &f,
        &other_token,
        f.channel,
        Uuid::new_v4(),
        "still authorized",
    )
    .await;
    assert_eq!(event(&mut other).await["message"], own);
    rejected(f.server.handshake(Some(&f.token), None, None).await, 401);
}

#[sqlx::test]
async fn session_expiry_closes_idle_and_replaying_sockets(pool: PgPool) {
    let f = fixture(&pool).await;
    sqlx::query("UPDATE sessions SET expires_at = clock_timestamp() + interval '2 seconds' WHERE organization_id = $1").bind(f.organization).execute(&pool).await.unwrap();
    let mut idle = f.server.connect(&f.token).await;
    subscribe(&mut idle, f.channel, 0).await;
    ready(&mut idle, f.channel, 0).await;
    let mut replay = f.server.connect(&f.token).await;
    let gate = pause(f.channel);
    subscribe(&mut replay, f.channel, 0).await;
    entered(&gate).await;
    closed(&mut idle, CLOSE_SESSION_ENDED).await;
    closed(&mut replay, CLOSE_SESSION_ENDED).await;
}

#[sqlx::test]
async fn session_check_database_timeout_at_connect_closes_with_internal_error(pool: PgPool) {
    let f = fixture(&pool).await;
    let exhausted = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(2))
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    let _held = exhausted.acquire().await.unwrap();
    // Authenticate normally, then exhaust only the pool used by the post-upgrade session check.
    let router = Router::new()
        .route(
            "/api/v1/ws",
            axum::routing::get(
                move |State(mut state): State<AppState>, auth: Auth, ws: WebSocketUpgrade| {
                    let exhausted = exhausted.clone();
                    async move {
                        state.pool = exhausted;
                        ws.on_upgrade(move |socket| connected(socket, state, auth))
                    }
                },
            ),
        )
        .with_state(f.state.clone());
    let server = Server::start(router).await;
    let mut socket = server.connect(&f.token).await;
    closed(&mut socket, 1011).await;
}

#[sqlx::test]
async fn malformed_controls_and_future_cursor_do_not_break_subscription_state(pool: PgPool) {
    let f = fixture(&pool).await;
    let mut socket = f.server.connect(&f.token).await;
    socket
        .send(tungstenite::Message::text("not json"))
        .await
        .unwrap();
    assert_eq!(
        event(&mut socket).await,
        json!({"type":"error","code":"invalid_input"})
    );
    subscribe(&mut socket, f.channel, -1).await;
    assert_eq!(event(&mut socket).await["code"], "invalid_input");
    subscribe(&mut socket, f.channel, 100).await;
    ready(&mut socket, f.channel, 0).await;
    for _ in 0..2 {
        let canonical = post(&f, f.channel).await;
        assert_eq!(event(&mut socket).await["message"], canonical);
    }
    silent(&mut socket).await;
    subscribe(&mut socket, f.channel, i64::MAX).await;
    ready(&mut socket, f.channel, 2).await;
    let canonical = post(&f, f.channel).await;
    assert_eq!(event(&mut socket).await["message"], canonical);
    silent(&mut socket).await;
}

#[sqlx::test]
async fn concurrent_message_delivery_is_in_channel_sequence_order(pool: PgPool) {
    let f = fixture(&pool).await;
    let mut socket = f.server.connect(&f.token).await;
    subscribe(&mut socket, f.channel, 0).await;
    ready(&mut socket, f.channel, 0).await;
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..32 {
        let app = f.app.clone();
        let token = f.token.clone();
        let channel = f.channel;
        tasks.spawn(async move {
            let response = request(
                &app,
                "POST",
                &format!("/api/v1/channels/{channel}/messages"),
                &token,
                json!({"client_message_id":Uuid::new_v4(),"body":"concurrent"}),
            )
            .await;
            assert_eq!(response.status(), StatusCode::CREATED);
        });
    }
    for seq in 1..=32 {
        assert_eq!(event(&mut socket).await["message"]["seq"], seq);
    }
    while let Some(result) = tasks.join_next().await {
        result.unwrap();
    }
    silent(&mut socket).await;
}

#[sqlx::test]
async fn live_delivery_rechecks_private_membership_after_subscription(pool: PgPool) {
    let f = fixture(&pool).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    let (recipient, token) = member(&pool, f.organization).await;
    sqlx::query(
        "INSERT INTO channel_members (organization_id, channel_id, member_id) VALUES ($1, $2, $3)",
    )
    .bind(f.organization)
    .bind(private)
    .bind(recipient)
    .execute(&pool)
    .await
    .unwrap();
    let mut recipient_socket = f.server.connect(&token).await;
    let mut owner = f.server.connect(&f.token).await;
    for socket in [&mut recipient_socket, &mut owner] {
        subscribe(socket, private, 0).await;
        ready(socket, private, 0).await;
    }
    let before = post(&f, private).await;
    assert_eq!(event(&mut recipient_socket).await["message"], before);
    assert_eq!(event(&mut owner).await["message"], before);
    sqlx::query("DELETE FROM channel_members WHERE organization_id = $1 AND channel_id = $2 AND member_id = $3")
        .bind(f.organization).bind(private).bind(recipient).execute(&pool).await.unwrap();
    let after = post(&f, private).await;
    assert_eq!(event(&mut owner).await["message"], after);
    silent(&mut recipient_socket).await;
    subscribe(&mut recipient_socket, private, 0).await;
    denied(&mut recipient_socket, private).await;
}

#[sqlx::test]
async fn publication_waits_for_commit_even_when_http_request_is_cancelled(pool: PgPool) {
    let f = fixture(&pool).await;
    // Hold a deferred INSERT trigger at the commit boundary, after the row was inserted.
    let lock = 1818_i64;
    let mut blocker = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(lock)
        .execute(&mut *blocker)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE FUNCTION pause_realtime_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(1818::bigint); RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER pause_realtime_commit AFTER INSERT ON messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pause_realtime_commit();").execute(&pool).await.unwrap();
    let mut queue = f.state.message_delivery.queue(f.organization, f.member, 8);
    queue.subscribe(f.channel);
    let app = f.app.clone();
    let token = f.token.clone();
    let channel = f.channel;
    let send = tokio::spawn(async move {
        request(
            &app,
            "POST",
            &format!("/api/v1/channels/{channel}/messages"),
            &token,
            json!({"client_message_id":Uuid::new_v4(),"body":"committing"}),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = 1818 AND NOT granted)").fetch_one(&pool).await.unwrap();
            if waiting { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    assert!(
        queue.events.try_recv().is_err(),
        "nothing may publish while commit is blocked"
    );
    send.abort();
    assert!(send.await.unwrap_err().is_cancelled());
    blocker.commit().await.unwrap();
    let committed = tokio::time::timeout(Duration::from_secs(5), queue.events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(committed.seq, 1);
    let history = messages::replay_page(&pool, f.organization, f.channel, 0, 1)
        .await
        .unwrap();
    assert_eq!(history[0].id, committed.id);
}

#[sqlx::test]
async fn out_of_order_publication_fills_committed_gaps_without_duplicate_delivery(pool: PgPool) {
    let f = fixture(&pool).await;
    let mut socket = f.server.connect(&f.token).await;
    subscribe(&mut socket, f.channel, 0).await;
    ready(&mut socket, f.channel, 0).await;
    let key = Uuid::new_v4();
    let gate = messages::pause_publication(key);
    let app = f.app.clone();
    let token = f.token.clone();
    let channel = f.channel;
    let first = tokio::spawn(async move {
        request(
            &app,
            "POST",
            &format!("/api/v1/channels/{channel}/messages"),
            &token,
            json!({"client_message_id":key,"body":"first"}),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let second = post(&f, f.channel).await;
    assert_eq!(second["seq"], 2);
    // seq 2 publishes first; the receiver must fill the committed prefix, then dedupe seq 1.
    let one = event(&mut socket).await;
    assert_eq!(one["message"]["seq"], 1);
    assert_eq!(one["message"]["client_message_id"], json!(key));
    assert_eq!(event(&mut socket).await["message"], second);
    gate.release.add_permits(1);
    assert_eq!(first.await.unwrap().status(), StatusCode::CREATED);
    f.state.message_delivery.flush().await;
    silent(&mut socket).await;
}

mod contract;
mod notification;
