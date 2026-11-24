use axum::{
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, header},
    middleware::Next,
    response::Response,
};

const PERMISSIONS_POLICY: &str = "accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), screen-wake-lock=(), serial=(), usb=(), web-share=(), xr-spatial-tracking=()";

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

pub(crate) async fn security_headers(
    State(secure): State<bool>,
    request: Request,
    next: Next,
) -> Response {
    let websocket = websocket_source(request.headers(), secure)
        .map(|s| format!(" {s}"))
        .unwrap_or_default();
    let policy = format!(
        "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'{websocket}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"
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
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static(PERMISSIONS_POLICY),
    );
    headers.insert(
        "cross-origin-opener-policy",
        HeaderValue::from_static("same-origin"),
    );
    if api {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AppState, app};
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    #[tokio::test]
    async fn security_headers_cover_success_errors_and_fallbacks() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        pool.close().await;
        for secure in [false, true] {
            let router = app(AppState {
                cookie_secure: secure,
                ..AppState::with_test_pool(pool.clone())
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
                assert!(csp.contains("script-src 'self' 'wasm-unsafe-eval'"));
                assert!(!csp.contains("'unsafe-eval'"));
                assert!(csp.contains("style-src 'self'"));
                assert!(!csp.replace("'wasm-unsafe-eval'", "").contains("unsafe-"));
                assert!(!csp.contains("evil.example"));
                assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
                assert_eq!(
                    headers[header::REFERRER_POLICY],
                    "strict-origin-when-cross-origin"
                );
                assert!(!headers.contains_key(header::STRICT_TRANSPORT_SECURITY));
                assert_eq!(headers["permissions-policy"], PERMISSIONS_POLICY);
                assert_eq!(headers["cross-origin-opener-policy"], "same-origin");
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
}
