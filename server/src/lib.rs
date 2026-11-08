pub mod auth;
pub mod channels;
pub mod messages;
pub mod openapi;
pub mod realtime;

use axum::{
    Router,
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../web/dist"]
struct Assets;

#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::PgPool,
    pub cookie_secure: bool,
    pub setup_token: Option<String>,
    pub sign_in_throttle: auth::SignInThrottle,
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
        .route(
            "/api/v1/channels",
            get(channels::list_channels).post(channels::create_channel),
        )
        .route(
            "/api/v1/channels/{id}/messages",
            get(messages::list_messages)
                .post(messages::send_message)
                // 4000 control characters escape to 6 bytes each in JSON, so the global 16 KiB would reject valid bodies.
                .layer(axum::extract::DefaultBodyLimit::max(32 * 1024)),
        )
        .route("/api/v1/ws", get(realtime::upgrade))
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
        .fallback(static_handler)
        .with_state(state)
}

#[utoipa::path(get, path = "/api/v1/health", responses((status = 200, body = String, content_type = "text/plain")))]
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
        return serve(path, file);
    }
    // A path whose last segment has an extension is an asset request: missing means 404,
    // not index.html. Anything else is a client-side route of the SPA.
    let last = path.rsplit('/').next().unwrap_or("");
    if last.contains('.') {
        return StatusCode::NOT_FOUND.into_response();
    }
    match Assets::get("index.html") {
        Some(file) => serve("index.html", file),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn serve(name: &str, file: rust_embed::EmbeddedFile) -> Response {
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
