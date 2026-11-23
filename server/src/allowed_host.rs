use axum::{
    Json,
    extract::{ConnectInfo, Request, State},
    http::{Method, StatusCode, header, uri::Authority},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::net::SocketAddr;

#[derive(Clone, Default)]
pub struct AllowedHost(Option<Authority>);

impl AllowedHost {
    pub fn configured(value: &str) -> Result<Self, &'static str> {
        const INVALID: &str =
            "FUKULOW_ALLOWED_HOST must be one hostname or IP with an optional port";
        if !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b))
        {
            return Err(INVALID);
        }
        let authority: Authority = value.parse().map_err(|_| INVALID)?;
        let host = authority.host();
        let valid_host = if let Some(ip) = host.strip_prefix('[').and_then(|s| s.strip_suffix(']'))
        {
            ip.parse::<std::net::Ipv6Addr>().is_ok()
        } else {
            host.strip_suffix('.')
                .unwrap_or(host)
                .split('.')
                .all(|label| {
                    !label.is_empty()
                        && !label.starts_with('-')
                        && !label.ends_with('-')
                        && label.len() <= 63
                        && label
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                })
        };
        if !valid_host || (value != host && !authority.port_u16().is_some_and(|port| port != 0)) {
            return Err(INVALID);
        }
        Ok(Self(Some(authority)))
    }
}

pub(crate) async fn check(
    State(allowed): State<AllowedHost>,
    request: Request,
    next: Next,
) -> Response {
    let Some(allowed) = allowed.0.as_ref().map(Authority::as_str) else {
        return next.run(request).await;
    };
    let mut hosts = request.headers().get_all(header::HOST).iter();
    let host = hosts.next().and_then(|h| h.to_str().ok());
    let single_host = hosts.next().is_none();
    if request.uri().path() == "/api/v1/ready" {
        // The container probe is the only caller that uses localhost as its Host.
        if single_host
            && host == Some("localhost")
            && request.method() == Method::GET
            && request.uri().authority().is_none()
            && request
                .extensions()
                .get::<ConnectInfo<SocketAddr>>()
                .is_some_and(|peer| peer.0.ip().to_canonical().is_loopback())
        {
            return next.run(request).await;
        }
        return (
            StatusCode::NOT_FOUND,
            [(header::CACHE_CONTROL, "no-store")],
            Json(crate::auth::ErrorBody {
                error: "not_found".into(),
            }),
        )
            .into_response();
    }
    if single_host
        && host.is_some_and(|host| host.eq_ignore_ascii_case(allowed))
        && request
            .uri()
            .authority()
            .is_none_or(|authority| authority.as_str().eq_ignore_ascii_case(allowed))
    {
        return next.run(request).await;
    }
    (
        StatusCode::MISDIRECTED_REQUEST,
        [(header::CACHE_CONTROL, "no-store")],
        Json(crate::auth::ErrorBody {
            error: "host_not_allowed".into(),
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, middleware};
    use tower::ServiceExt;

    #[tokio::test]
    async fn external_host_gate_rejects_foreign_hosts_and_keeps_readiness_private() {
        let router = Router::new().fallback(|| async { StatusCode::OK }).layer(
            middleware::from_fn_with_state(
                AllowedHost::configured("chat.example:8443").unwrap(),
                check,
            ),
        );
        for (path, host, extra_host, peer, status) in [
            (
                "/",
                Some("CHAT.example:8443"),
                None,
                "192.0.2.1:1234",
                StatusCode::OK,
            ),
            (
                "/",
                Some("foreign.example"),
                None,
                "192.0.2.1:1234",
                StatusCode::MISDIRECTED_REQUEST,
            ),
            (
                "/",
                Some("chat.example"),
                None,
                "192.0.2.1:1234",
                StatusCode::MISDIRECTED_REQUEST,
            ),
            (
                "/",
                None,
                None,
                "192.0.2.1:1234",
                StatusCode::MISDIRECTED_REQUEST,
            ),
            (
                "/",
                Some("chat.example:8443"),
                Some("foreign.example"),
                "192.0.2.1:1234",
                StatusCode::MISDIRECTED_REQUEST,
            ),
            (
                "https://foreign.example/",
                Some("chat.example:8443"),
                None,
                "192.0.2.1:1234",
                StatusCode::MISDIRECTED_REQUEST,
            ),
            (
                "/api/v1/orgs/id/ws",
                Some("foreign.example"),
                None,
                "192.0.2.1:1234",
                StatusCode::MISDIRECTED_REQUEST,
            ),
            (
                "/api/v1/ready",
                Some("chat.example:8443"),
                None,
                "192.0.2.1:1234",
                StatusCode::NOT_FOUND,
            ),
            (
                "/api/v1/ready",
                Some("localhost"),
                None,
                "192.0.2.1:1234",
                StatusCode::NOT_FOUND,
            ),
            (
                "/api/v1/ready",
                Some("localhost"),
                None,
                "127.0.0.1:1234",
                StatusCode::OK,
            ),
            (
                "/api/v1/ready",
                Some("localhost"),
                None,
                "[::1]:1234",
                StatusCode::OK,
            ),
            (
                "/",
                Some("localhost"),
                None,
                "127.0.0.1:1234",
                StatusCode::MISDIRECTED_REQUEST,
            ),
        ] {
            let mut request = Request::builder()
                .uri(path)
                .header("x-forwarded-host", "chat.example:8443")
                .header("x-forwarded-for", "127.0.0.1")
                .extension(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
            for host in [host, extra_host].into_iter().flatten() {
                request = request.header(header::HOST, host);
            }
            let response = router
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                status,
                "{path}: {host:?} {extra_host:?} from {peer}"
            );
        }
    }
}
