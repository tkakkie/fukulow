use axum::http::{HeaderMap, Uri, header};

#[derive(Clone, Default)]
pub struct AllowedOrigins(Vec<Origin>);

#[derive(Clone, PartialEq, Eq)]
struct Origin {
    scheme: String,
    host: String,
    port: u16,
}

fn parse(value: &str) -> Option<Origin> {
    let uri: Uri = value.parse().ok()?;
    let scheme = uri.scheme_str()?;
    if !matches!(scheme, "http" | "https")
        || uri.path_and_query().is_some_and(|p| p.as_str() != "/")
    {
        return None;
    }
    let authority = uri.authority()?;
    if authority.as_str().contains('@') {
        return None;
    }
    let suffix = authority.as_str().strip_prefix(authority.host())?;
    let port = if suffix.is_empty() {
        if scheme == "https" { 443 } else { 80 }
    } else {
        suffix.strip_prefix(':')?.parse::<u16>().ok()?
    };
    Some(Origin {
        scheme: scheme.into(),
        host: authority.host().to_ascii_lowercase(),
        port,
    })
}

impl AllowedOrigins {
    pub fn configured(value: Option<&str>) -> Result<Self, &'static str> {
        let Some(value) = value else {
            return Ok(Self::default());
        };
        let origins: Option<Vec<_>> = value.split(',').map(|v| parse(v.trim())).collect();
        origins
            .filter(|o| !o.is_empty())
            .map(Self)
            .ok_or("FUKULOW_WS_ALLOWED_ORIGINS must contain comma-separated http(s) origins")
    }

    pub(crate) fn permits(&self, headers: &HeaderMap, secure: bool) -> bool {
        // Authorization takes precedence over cookies in the Auth extractor as well.
        if headers.contains_key(header::AUTHORIZATION) {
            return true;
        }
        let mut origins = headers.get_all(header::ORIGIN).iter();
        let origin = origins.next().and_then(|v| v.to_str().ok()).and_then(parse);
        if origins.next().is_some() {
            return false;
        }
        let Some(origin) = origin else {
            return false;
        };
        if !self.0.is_empty() {
            return self.0.contains(&origin);
        }
        let mut hosts = headers.get_all(header::HOST).iter();
        let own = hosts.next().and_then(|v| v.to_str().ok()).and_then(|host| {
            parse(&format!(
                "{}://{host}",
                if secure { "https" } else { "http" }
            ))
        });
        hosts.next().is_none() && own.as_ref() == Some(&origin)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origin_policy_requires_one_matching_cookie_origin_but_allows_bearer_without_origin() {
        let policy = AllowedOrigins::default();
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "chat.example".parse().unwrap());
        assert!(!policy.permits(&headers, true));
        for value in [
            "https://evil.example",
            "null",
            "http://chat.example",
            "https://chat.example/path",
            "https://chat.example@evil.example",
        ] {
            headers.insert(header::ORIGIN, value.parse().unwrap());
            assert!(!policy.permits(&headers, true), "{value}");
        }
        headers.insert(header::ORIGIN, "https://CHAT.example:443".parse().unwrap());
        assert!(policy.permits(&headers, true));
        headers.append(header::ORIGIN, "https://chat.example".parse().unwrap());
        assert!(!policy.permits(&headers, true));
        headers.remove(header::ORIGIN);
        headers.insert(header::AUTHORIZATION, "Bearer native".parse().unwrap());
        assert!(policy.permits(&headers, true));
    }
    #[test]
    fn configured_origins_are_exact_and_invalid_configuration_is_rejected() {
        let policy =
            AllowedOrigins::configured(Some("https://web.example,http://localhost:5173")).unwrap();
        let mut headers = HeaderMap::new();
        for (origin, allowed) in [
            ("https://web.example", true),
            ("http://localhost:5173", true),
            ("https://web.example.evil", false),
            ("http://localhost", false),
        ] {
            headers.insert(header::ORIGIN, origin.parse().unwrap());
            assert_eq!(policy.permits(&headers, true), allowed);
        }
        for invalid in [
            "",
            "*",
            "null",
            "https://web.example/path",
            "ftp://web.example",
            "https://web.example,",
            "https://web.example:99999",
            "https://web.example:",
        ] {
            assert!(
                AllowedOrigins::configured(Some(invalid)).is_err(),
                "{invalid}"
            );
        }
    }
}
