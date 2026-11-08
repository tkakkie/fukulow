use axum::{
    Router,
    body::Body,
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../web/dist"]
struct Assets;

pub fn app() -> Router {
    Router::new()
        .route("/api/v1/health", get(|| async { "ok" }))
        .fallback(static_handler)
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
    Response::builder()
        .header(header::CONTENT_TYPE, mime.as_ref())
        .body(Body::from(file.data.into_owned()))
        .unwrap()
}

#[tokio::main]
async fn main() {
    let addr = std::env::var("FUKULOW_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("listening on {addr}");
    axum::serve(listener, app()).await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    async fn get(path: &str) -> Response {
        app()
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
