use axum::{
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

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

pub(crate) async fn static_handler(uri: Uri, headers: HeaderMap) -> Response {
    let path = uri.path().trim_start_matches('/');
    // Undefined API endpoints are never the SPA.
    if path == "api"
        || path.starts_with("api/")
        || path.starts_with(".vite/")
        || path.ends_with(".br")
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if let Some(file) = Assets::get(path) {
        return serve_asset(path, file, &headers);
    }
    // A path whose last segment has an extension is an asset request: missing means 404,
    // not index.html. Anything else is a client-side route of the SPA.
    let last = path.rsplit('/').next().unwrap_or("");
    if last.contains('.') {
        return StatusCode::NOT_FOUND.into_response();
    }
    match Assets::get("index.html") {
        Some(file) => serve_asset("index.html", file, &headers),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn serve_asset(name: &str, file: rust_embed::EmbeddedFile, headers: &HeaderMap) -> Response {
    let compressed = accepts_brotli(headers)
        .then(|| Assets::get(&format!("{name}.br")))
        .flatten();
    let encoded = compressed.is_some();
    let file = compressed.unwrap_or(file);
    let guessed = mime_guess::from_path(name).first_or_octet_stream();
    let mime = if name.ends_with(".wasm") {
        "application/wasm"
    } else {
        guessed.as_ref()
    };
    let cache = if is_hashed_asset(name) {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut response = (
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, cache),
            (header::VARY, "Accept-Encoding"),
        ],
        file.data,
    )
        .into_response();
    if encoded {
        response
            .headers_mut()
            .insert(header::CONTENT_ENCODING, HeaderValue::from_static("br"));
    }
    response
}

fn accepts_brotli(headers: &HeaderMap) -> bool {
    let mut explicit = None;
    let mut wildcard = None;
    for value in headers.get_all(header::ACCEPT_ENCODING) {
        let Ok(value) = value.to_str() else { continue };
        for coding in value.split(',') {
            let mut parts = coding.split(';').map(str::trim);
            let name = parts.next().unwrap_or("");
            let quality = match parts.next() {
                None => true,
                Some(parameter) => parameter.split_once('=').is_some_and(|(key, value)| {
                    let value = value.trim();
                    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
                    key.trim().eq_ignore_ascii_case("q")
                        && fraction.len() <= 3
                        && fraction.bytes().all(|b| b.is_ascii_digit())
                        && match whole {
                            "0" => fraction.bytes().any(|b| b != b'0'),
                            "1" => fraction.bytes().all(|b| b == b'0'),
                            _ => false,
                        }
                }),
            } && parts.next().is_none();
            if name.eq_ignore_ascii_case("br") {
                // A refusal wins over duplicate entries and wildcard acceptance.
                explicit = Some(explicit.unwrap_or(true) && quality);
            } else if name == "*" {
                wildcard = Some(wildcard.unwrap_or(true) && quality);
            }
        }
    }
    explicit.or(wildcard).unwrap_or(false)
}

fn is_hashed_asset(name: &str) -> bool {
    HASHED_ASSETS.contains(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{get, get_encoded};

    fn content_type(res: &Response) -> String {
        res.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .to_string()
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
        for name in Assets::iter().filter(|n| n.starts_with("assets/") && !n.ends_with(".br")) {
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
    async fn all_public_assets_negotiate_brotli_without_changing_mime_or_cache() {
        let mut checked = 0;
        for name in Assets::iter().filter(|n| !n.starts_with('.') && !n.ends_with(".br")) {
            let raw = Assets::get(&name).unwrap().data;
            let compressed = Assets::get(&format!("{name}.br"))
                .expect("build Brotli assets first")
                .data;
            let identity = get(&format!("/{name}")).await;
            let mime = content_type(&identity);
            let cache = identity.headers()[header::CACHE_CONTROL].clone();
            for (encoding, br) in [
                (None, false),
                (Some(""), false),
                (Some("gzip, zstd"), false),
                (Some("br"), true),
                (Some("gzip, br;q=0.5"), true),
                (Some("br;q=0, gzip"), false),
                (Some("*;q=1, br;q=0"), false),
                (Some("*;q=0.5"), true),
                (Some("*;q=0"), false),
                (Some("BR;Q=1.000"), true),
                (Some("br;q=0.001"), true),
                (Some("br;q=0.000"), false),
                (Some("br;q=1.001"), false),
                (Some("br;q=invalid"), false),
                (Some("br, br;q=0"), false),
                (Some("*;q=0, *;q=0.5"), false),
            ] {
                let response = get_encoded(&format!("/{name}"), encoding).await;
                assert_eq!(response.status(), StatusCode::OK, "{name} {encoding:?}");
                assert_eq!(content_type(&response), mime);
                assert_eq!(response.headers()[header::CACHE_CONTROL], cache);
                assert_eq!(response.headers()[header::VARY], "Accept-Encoding");
                assert_eq!(
                    response
                        .headers()
                        .get(header::CONTENT_ENCODING)
                        .map(|v| v.to_str().unwrap()),
                    br.then_some("br")
                );
                let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap();
                assert_eq!(
                    body.as_ref(),
                    if br {
                        compressed.as_ref()
                    } else {
                        raw.as_ref()
                    }
                );
            }
            checked += 1;
        }
        assert!(checked > 0);
        let root = get_encoded("/channels/general", Some("br")).await;
        assert_eq!(root.headers()[header::CONTENT_ENCODING], "br");
        assert_eq!(root.headers()[header::CACHE_CONTROL], "no-cache");
        for path in [
            "/.vite/manifest.json.br",
            "/index.html.br",
            "/assets/missing.wasm",
        ] {
            assert_eq!(
                get_encoded(path, Some("br")).await.status(),
                StatusCode::NOT_FOUND
            );
        }
    }

    #[test]
    fn brotli_negotiation_reads_repeated_header_fields() {
        let mut headers = HeaderMap::new();
        headers.append(header::ACCEPT_ENCODING, HeaderValue::from_static("gzip"));
        headers.append(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("br;q=0.5"),
        );
        assert!(accepts_brotli(&headers));
        headers.append(header::ACCEPT_ENCODING, HeaderValue::from_static("br;q=0"));
        assert!(!accepts_brotli(&headers));
    }

    #[tokio::test]
    async fn wasm_and_glue_are_manifest_assets_with_immutable_cache_and_wasm_mime() {
        let manifest = Assets::get(".vite/manifest.json").expect("build web first");
        let chunks: HashMap<String, ManifestChunk> =
            serde_json::from_slice(&manifest.data).unwrap();
        let wasm: Vec<_> = chunks
            .values()
            .map(|c| &c.file)
            .filter(|name| name.ends_with(".wasm"))
            .collect();
        let glue: Vec<_> = chunks
            .values()
            .map(|c| &c.file)
            .filter(|name| name.contains("sync-wasm") && name.ends_with(".js"))
            .collect();
        assert_eq!(wasm.len(), 1);
        assert_eq!(glue.len(), 1);
        for name in wasm.iter().chain(glue.iter()) {
            assert!(is_hashed_asset(name));
            let response = get(&format!("/{name}")).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "public, max-age=31536000, immutable"
            );
            if name.ends_with(".wasm") {
                assert_eq!(content_type(&response), "application/wasm");
            }
        }
        assert!(!is_hashed_asset("assets/unlisted-abc12345.wasm"));
        assert!(!is_hashed_asset("assets/sync-wasm-abc12345.js"));
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
