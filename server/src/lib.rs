pub mod auth;
pub mod channels;
pub mod database;
pub mod messages;
pub mod openapi;
pub mod realtime;
pub mod shutdown;

#[cfg(test)]
mod test_support;

use axum::{
    Router,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use rust_embed::RustEmbed;
use shutdown::Shutdown;
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::LazyLock,
    time::Duration,
};

pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(serde::Deserialize)]
struct ManifestChunk {
    file: String,
    #[serde(default)]
    css: Vec<String>,
    #[serde(default)]
    assets: Vec<String>,
}

// The Vite manifest identifies build outputs; filename patterns could cache unhashed public files forever.
static HASHED_ASSETS: LazyLock<HashSet<String>> = LazyLock::new(|| {
    Assets::get(".vite/manifest.json")
        .and_then(|file| serde_json::from_slice::<HashMap<String, ManifestChunk>>(&file.data).ok())
        .into_iter()
        .flat_map(|manifest| manifest.into_values())
        .flat_map(|chunk| {
            std::iter::once(chunk.file)
                .chain(chunk.css)
                .chain(chunk.assets)
        })
        .filter(|name| name.starts_with("assets/"))
        .collect()
});

#[derive(RustEmbed)]
#[folder = "../web/dist"]
struct Assets;

#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::PgPool,
    pub shutdown: shutdown::Shutdown,
    pub cookie_secure: bool,
    pub setup_token: String,
    pub sign_in_throttle: auth::SignInThrottle,
    pub message_delivery: messages::Delivery,
    pub session_changes: auth::SessionChanges,
    pub session_cleanup: auth::SessionCleanup,
    pub ws_allowed_origins: realtime::AllowedOrigins,
}

#[cfg(test)]
impl AppState {
    pub(crate) fn for_test(pool: sqlx::PgPool) -> Self {
        Self {
            pool,
            cookie_secure: true,
            setup_token: "setup-token-test-only".into(),
            sign_in_throttle: Default::default(),
            message_delivery: Default::default(),
            session_changes: Default::default(),
            session_cleanup: Default::default(),
            shutdown: Default::default(),
            ws_allowed_origins: Default::default(),
        }
    }
}

pub fn app(state: AppState) -> Router {
    state
        .session_changes
        .set_subscription_recheck(std::sync::Arc::new(
            state.message_delivery.channel_access.clone(),
        ));
    let cookie_secure = state.cookie_secure;
    let readiness = Readiness {
        pool: state.pool.clone(),
        sessions: state.session_changes.clone(),
        flight: Default::default(),
    };
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/ready", get(ready).with_state(readiness))
        .route("/api/v1/setup", get(auth::setup_status).post(auth::setup))
        .route(
            "/api/v1/session",
            axum::routing::post(auth::sign_in).delete(auth::sign_out),
        )
        .route(
            "/api/v1/native/session",
            axum::routing::post(auth::native_sign_in),
        )
        .route("/api/v1/me", get(auth::me))
        .route("/api/v1/orgs/{org}/me", get(auth::organization_me))
        .route(
            "/api/v1/orgs/{org}/members",
            get(auth::members::list_members),
        )
        .route(
            "/api/v1/orgs/{org}/members/{id}/role",
            axum::routing::patch(auth::members::change_role::<channels::members::RoleChangeGuard>),
        )
        .route(
            "/api/v1/orgs/{org}/invites",
            axum::routing::post(auth::invites::create_invite),
        )
        .route(
            "/api/v1/orgs/{org}/invites/accept",
            axum::routing::post(auth::invites::accept_invite),
        )
        .route(
            "/api/v1/orgs/{org}/channels",
            get(messages::list_channels).post(channels::create_channel),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/members",
            get(channels::members::list).post(channels::members::add),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/members/{member_id}",
            axum::routing::delete(channels::members::remove),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/messages",
            get(messages::list_messages)
                .post(messages::send_message)
                // 4000 control characters escape to 6 bytes each in JSON, so the global 16 KiB would reject valid bodies.
                .layer(axum::extract::DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/read",
            axum::routing::put(messages::mark_channel_read),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/topics/{topic_id}/read",
            axum::routing::put(messages::mark_topic_read),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/messages/{message_id}/chain",
            get(messages::reply_chain),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/timeline",
            get(messages::list_timeline),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/topics",
            get(messages::list_topics),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/topics/{topic_id}",
            get(messages::topic_summary),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/topics/{topic_id}/messages",
            get(messages::topic_history),
        )
        .route("/api/v1/orgs/{org}/ws", get(realtime::upgrade))
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
        .fallback(static_handler)
        .layer(axum::middleware::from_fn_with_state(
            state.shutdown.clone(),
            reject_new_requests,
        ))
        .layer(middleware::from_fn_with_state(
            cookie_secure,
            security_headers,
        ))
        .with_state(state)
}

pub(crate) async fn reject_new_requests(
    State(shutdown): State<Shutdown>,
    request: axum::extract::Request,
    next: Next,
) -> axum::response::Response {
    if shutdown.is_stopped() {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            [
                (
                    header::RETRY_AFTER,
                    rand::random_range(1..=5_u64).to_string(),
                ),
                (header::CACHE_CONTROL, "no-store".to_owned()),
            ],
            axum::Json(crate::auth::ErrorBody {
                error: "shutting_down".into(),
            }),
        )
            .into_response();
    }
    next.run(request).await
}

/// The caller must terminate the process on expiry, without waiting for pool/runtime teardown.
pub async fn serve(
    listener: tokio::net::TcpListener,
    state: AppState,
    signal: impl Future<Output = ()>,
    deadline: Duration,
) -> std::io::Result<bool> {
    let shutdown = state.shutdown.clone();
    let pool = state.pool.clone();
    let delivery = state.message_delivery.clone();
    let stop_accepting = shutdown.clone();
    let server = axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move { stop_accepting.cancelled().await })
    .into_future();
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => { result?; return Ok(true); }
        _ = signal => {}
    }
    let bound = tokio::time::Instant::now() + deadline;
    shutdown.begin();
    let drain = async {
        server.await?;
        // HTTP completion alone misses persistence whose caller disconnected,
        // and the notification spawned immediately before persistence completes.
        delivery.drained().await;
        shutdown.sockets.drained().await;
        pool.close().await;
        Ok::<_, std::io::Error>(())
    };
    match tokio::time::timeout_at(bound, drain).await {
        Ok(result) => {
            result?;
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

/// Register both handlers before accepting any connections.
pub fn signal() -> std::io::Result<impl Future<Output = ()>> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    Ok(async move {
        tokio::select! {
            _ = term.recv() => {}
            _ = interrupt.recv() => {}
        }
    })
}

// Host is validated as an authority and restricted to CSP source characters before reflection.
fn websocket_source(headers: &HeaderMap, secure: bool) -> Option<String> {
    let mut hosts = headers.get_all(header::HOST).iter();
    let host = hosts.next()?.to_str().ok()?;
    if hosts.next().is_some()
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b))
    {
        return None;
    }
    let authority: axum::http::uri::Authority = host.parse().ok()?;
    if authority.host().is_empty() {
        return None;
    }
    Some(format!("{}://{host}", if secure { "wss" } else { "ws" }))
}

async fn security_headers(State(secure): State<bool>, request: Request, next: Next) -> Response {
    let websocket = websocket_source(request.headers(), secure)
        .map(|s| format!(" {s}"))
        .unwrap_or_default();
    let policy = format!(
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'{websocket}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"
    );
    let api = request.uri().path() == "/api" || request.uri().path().starts_with("/api/");
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_str(&policy).unwrap_or_else(|_| {
            HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'")
        }),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    if api {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

#[utoipa::path(get, path = "/api/v1/health", responses((status = 200, description = "Server is responding; returns the plain-text body ok", body = String, content_type = "text/plain")))]
async fn health() -> Result<&'static str, auth::ApiError> {
    auth::authorization::require(
        auth::Actor::Anonymous,
        auth::Action::Public,
        auth::Resource::Global,
    )?;
    Ok("ok")
}

#[derive(Clone)]
struct Readiness {
    pool: sqlx::PgPool,
    sessions: auth::SessionChanges,
    flight: std::sync::Arc<tokio::sync::Mutex<Option<tokio::sync::watch::Receiver<Option<bool>>>>>,
}

impl Readiness {
    async fn check(&self) -> bool {
        let mut flight = self.flight.lock().await;
        let mut result = match flight.as_ref() {
            Some(result) if result.borrow().is_none() && result.has_changed().is_ok() => {
                result.clone()
            }
            _ => {
                let (sender, result) = tokio::sync::watch::channel(None);
                let pool = self.pool.clone();
                let sessions = self.sessions.clone();
                // The bounded check outlives any individual HTTP caller. Completed
                // results are replaced on the next call, never cached across checks.
                tokio::spawn(async move {
                    let healthy = sessions.fallback_available()
                        && database::ready(&pool).await
                        && sessions.fallback_available();
                    let _ = sender.send(Some(healthy));
                });
                *flight = Some(result.clone());
                result
            }
        };
        drop(flight);
        matches!(result.wait_for(|value| value.is_some()).await, Ok(value) if *value == Some(true))
    }
}

#[utoipa::path(get, path = "/api/v1/ready", responses(
    (status = 200, description = "Database check succeeded, connection cleanup completed and the fallback supervisor has not observed an abnormal worker exit (not a progress watchdog); returns plain-text ok", body = String, content_type = "text/plain"),
    (status = 503, description = "Readiness unavailable: error not_ready (Retry-After: 1); database check failed, acquisition/query/connection cleanup timed out, or the fallback supervisor observed an abnormal worker exit", body = auth::ErrorBody)
))]
async fn ready(State(readiness): State<Readiness>) -> Response {
    if readiness.check().await {
        return "ok".into_response();
    }
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::RETRY_AFTER, "1")],
        axum::Json(auth::ErrorBody {
            error: "not_ready".into(),
        }),
    )
        .into_response()
}

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    // Undefined API endpoints are never the SPA.
    if path == "api" || path.starts_with("api/") || path.starts_with(".vite/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    if let Some(file) = Assets::get(path) {
        return serve_asset(path, file);
    }
    // A path whose last segment has an extension is an asset request: missing means 404,
    // not index.html. Anything else is a client-side route of the SPA.
    let last = path.rsplit('/').next().unwrap_or("");
    if last.contains('.') {
        return StatusCode::NOT_FOUND.into_response();
    }
    match Assets::get("index.html") {
        Some(file) => serve_asset("index.html", file),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn serve_asset(name: &str, file: rust_embed::EmbeddedFile) -> Response {
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    let cache = if is_hashed_asset(name) {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        [
            (header::CONTENT_TYPE, mime.as_ref()),
            (header::CACHE_CONTROL, cache),
        ],
        file.data,
    )
        .into_response()
}

fn is_hashed_asset(name: &str) -> bool {
    HASHED_ASSETS.contains(name)
}

#[cfg(test)]
mod tests {
    mod readiness;
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    async fn get(path: &str) -> Response {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@localhost/unused")
            .unwrap();
        app(AppState {
            pool,
            cookie_secure: true,
            setup_token: "setup-token-test-only".into(),
            sign_in_throttle: Default::default(),
            message_delivery: Default::default(),
            session_changes: Default::default(),
            session_cleanup: Default::default(),
            shutdown: Default::default(),
            ws_allowed_origins: Default::default(),
        })
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap()
    }

    fn content_type(res: &Response) -> String {
        res.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn health_ok() {
        assert_eq!(get("/api/v1/health").await.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn index_is_served_at_root() {
        let res = get("/").await;
        assert_eq!(res.status(), StatusCode::OK);
        assert!(content_type(&res).starts_with("text/html"));
    }

    #[tokio::test]
    async fn spa_route_gets_index_html() {
        let res = get("/channels/general/topics/1").await;
        assert_eq!(res.status(), StatusCode::OK);
        assert!(content_type(&res).starts_with("text/html"));
    }

    #[tokio::test]
    async fn existing_assets_are_served_with_their_type() {
        let mut checked = 0;
        for name in Assets::iter().filter(|n| n.starts_with("assets/")) {
            let res = get(&format!("/{name}")).await;
            assert_eq!(res.status(), StatusCode::OK, "{name}");
            assert!(!content_type(&res).starts_with("text/html"), "{name}");
            checked += 1;
        }
        assert!(
            checked > 0,
            "web/dist has no assets; build the web app first"
        );
    }

    #[tokio::test]
    async fn missing_asset_is_404_not_html() {
        for path in [
            "/assets/missing.js",
            "/missing.css",
            "/favicon.png",
            "/.vite/manifest.json",
        ] {
            assert_eq!(get(path).await.status(), StatusCode::NOT_FOUND, "{path}");
        }
    }

    #[tokio::test]
    async fn undefined_api_paths_are_404() {
        for path in ["/api", "/api/", "/api/v1/nope", "/api/v1/health/x"] {
            assert_eq!(get(path).await.status(), StatusCode::NOT_FOUND, "{path}");
        }
    }

    #[tokio::test]
    async fn path_merely_starting_with_api_is_a_spa_route() {
        assert_eq!(get("/apixyz").await.status(), StatusCode::OK);
    }
    #[tokio::test]
    async fn security_headers_cover_success_errors_and_fallbacks() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        pool.close().await;
        for secure in [false, true] {
            let router = app(AppState {
                cookie_secure: secure,
                ..AppState::for_test(pool.clone())
            });
            for (method, path, content_type, input, status) in [
                ("GET", "/", "application/json", "", 200),
                ("GET", "/channels/general", "application/json", "", 200),
                ("GET", "/favicon.svg", "application/json", "", 200),
                ("GET", "/api/v1/health", "application/json", "", 200),
                ("GET", "/missing.js", "application/json", "", 404),
                ("GET", "/api/v1/missing", "application/json", "", 404),
                ("POST", "/api/v1/health", "application/json", "", 405),
                ("POST", "/api/v1/session", "application/json", "{", 400),
                ("POST", "/api/v1/native/session", "text/plain", "{}", 415),
                (
                    "POST",
                    "/api/v1/session",
                    "application/json",
                    &"x".repeat(17 * 1024),
                    413,
                ),
                ("GET", "/api/v1/me", "application/json", "", 401),
                (
                    "GET",
                    "/api/v1/orgs/unknown/ws",
                    "application/json",
                    "",
                    403,
                ),
                ("GET", "/api/v1/setup", "application/json", "", 500),
            ] {
                let response = router
                    .clone()
                    .oneshot(
                        Request::builder()
                            .method(method)
                            .uri(path)
                            .extension(axum::extract::ConnectInfo(
                                "192.0.2.1:1234".parse::<std::net::SocketAddr>().unwrap(),
                            ))
                            .header(header::HOST, "chat.example:18443")
                            .header("x-forwarded-host", "evil.example")
                            .header(header::CONTENT_TYPE, content_type)
                            .body(Body::from(input.to_owned()))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status().as_u16(), status, "{method} {path}");
                let headers = response.headers();
                let csp = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
                let scheme = if secure { "wss" } else { "ws" };
                assert!(csp.contains(&format!(
                    "connect-src 'self' {scheme}://chat.example:18443;"
                )));
                assert!(csp.contains("frame-ancestors 'none'"));
                assert!(csp.contains("script-src 'self'"));
                assert!(csp.contains("style-src 'self'"));
                assert!(!csp.contains("unsafe-"));
                assert!(!csp.contains("evil.example"));
                assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
                assert_eq!(
                    headers[header::REFERRER_POLICY],
                    "strict-origin-when-cross-origin"
                );
                assert!(!headers.contains_key(header::STRICT_TRANSPORT_SECURITY));
                if path.starts_with("/api/") {
                    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
                }
            }
        }
    }

    #[test]
    fn csp_websocket_source_rejects_injected_or_ambiguous_hosts() {
        let mut headers = HeaderMap::new();
        for host in [
            "chat.example;script-src *",
            "chat.example'",
            "user@chat.example",
            "chat.example/path",
            "chat.example:443 evil.example",
        ] {
            headers.insert(header::HOST, host.parse().unwrap());
            assert!(websocket_source(&headers, true).is_none(), "{host}");
        }
        headers.insert(header::HOST, "[::1]:18443".parse().unwrap());
        assert_eq!(
            websocket_source(&headers, true).as_deref(),
            Some("wss://[::1]:18443")
        );
        headers.append(header::HOST, "evil.example".parse().unwrap());
        assert!(websocket_source(&headers, true).is_none());
    }

    #[tokio::test]
    async fn html_and_unhashed_files_revalidate_and_hashed_assets_are_immutable() {
        let manifest = Assets::get(".vite/manifest.json").expect(
            "web/dist/.vite/manifest.json is missing: build the SPA and preserve hidden files in the web-dist artifact",
        );
        serde_json::from_slice::<HashMap<String, ManifestChunk>>(&manifest.data)
            .expect("web/dist/.vite/manifest.json must be a valid Vite manifest");
        for path in ["/", "/index.html", "/channels/general", "/favicon.svg"] {
            assert_eq!(
                get(path).await.headers()[header::CACHE_CONTROL],
                "no-cache",
                "{path}"
            );
        }
        let mut checked = 0;
        for name in HASHED_ASSETS.iter() {
            assert_eq!(
                get(&format!("/{name}")).await.headers()[header::CACHE_CONTROL],
                "public, max-age=31536000, immutable"
            );
            checked += 1;
        }
        assert!(
            checked > 0,
            "Vite manifest must list hashed assets under assets/"
        );
        for name in [
            "assets/app.js",
            "assets/logo.svg",
            "assets/app-unhashed.js",
            "app-12345678.js",
            "assets/app-1234.js",
        ] {
            assert!(!is_hashed_asset(name), "{name}");
        }
    }
}
