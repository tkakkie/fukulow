use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// The server's JSON/empty REST responses have a known Content-Length. Use a small
// HTTP/1.1 client for those responses rather than adding a test-only HTTP dependency.
pub(super) async fn request(
    address: std::net::SocketAddr,
    method: &str,
    path: impl AsRef<str>,
    token: impl AsRef<str>,
    input: Value,
) -> (u16, Value) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut stream = TcpStream::connect(address).await.unwrap();
        let body = if input.is_null() { String::new() } else { input.to_string() };
        let request = format!(
            "{method} {} HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            path.as_ref(), token.as_ref(), body.len(),
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.unwrap();
        let header_end = bytes.windows(4).position(|part| part == b"\r\n\r\n").unwrap();
        let headers = std::str::from_utf8(&bytes[..header_end]).unwrap();
        let status = headers.lines().next().unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
        let body = &bytes[header_end + 4..];
        let length = headers.lines().filter_map(|line| line.split_once(':')).find(|(name, _)| name.eq_ignore_ascii_case("content-length")).map(|(_, value)| value.trim().parse::<usize>().unwrap());
        if status == 204 {
            assert!(body.is_empty());
            (status, Value::Null)
        } else {
            assert_eq!(length, Some(body.len()), "unexpected HTTP framing: {headers}");
            (status, serde_json::from_slice(body).unwrap())
        }
    }).await.expect("HTTP request timed out")
}
