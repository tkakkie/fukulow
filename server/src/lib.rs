pub mod auth;
pub mod channels;
pub mod messages;
pub mod openapi;
pub mod realtime;
pub mod shutdown;

use axum::{
    Router,
    extract::State,
    http::{StatusCode, Uri, header},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::get,
};
use rust_embed::RustEmbed;
use shutdown::Shutdown;
use std::{future::Future, time::Duration};

pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(RustEmbed)]
#[folder = "../web/dist"]
struct Assets;

#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::PgPool,
    pub shutdown: shutdown::Shutdown,
    pub cookie_secure: bool,
    pub setup_token: Option<String>,
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
            setup_token: None,
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
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/setup", get(auth::setup_status).post(auth::setup))
        .route(
            "/api/v1/session",
            axum::routing::post(auth::sign_in).delete(auth::sign_out),
        )
        .route("/api/v1/me", get(auth::me))
        .route("/api/v1/orgs/{org}/me", get(auth::organization_me))
        .route(
            "/api/v1/orgs/{org}/channels",
            get(channels::list_channels).post(channels::create_channel),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/messages",
            get(messages::list_messages)
                .post(messages::send_message)
                // 4000 control characters escape to 6 bytes each in JSON, so the global 16 KiB would reject valid bodies.
                .layer(axum::extract::DefaultBodyLimit::max(32 * 1024)),
        )
        .route("/api/v1/orgs/{org}/ws", get(realtime::upgrade))
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
        .fallback(static_handler)
        .layer(axum::middleware::from_fn_with_state(
            state.shutdown.clone(),
            reject_new_requests,
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
            axum::Json(crate::auth::ErrorBody {
                error: "server shutting down".into(),
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

#[utoipa::path(get, path = "/api/v1/health", responses((status = 200, description = "Server is responding; returns the plain-text body ok", body = String, content_type = "text/plain")))]
async fn health() -> &'static str {
    "ok"
}

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    // Undefined API endpoints are never the SPA.
    if path == "api" || path.starts_with("api/") {
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
    ([(header::CONTENT_TYPE, mime.as_ref())], file.data).into_response()
}

#[cfg(test)]
mod tests {
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
            setup_token: None,
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
        for path in ["/assets/missing.js", "/missing.css", "/favicon.png"] {
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
}
