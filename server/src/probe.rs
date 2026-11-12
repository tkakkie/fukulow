use std::{io, net::IpAddr, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) async fn run(address: &str) -> io::Result<()> {
    tokio::time::timeout(Duration::from_secs(1), async {
        let mut address = tokio::net::lookup_host(address)
            .await?
            .next()
            .ok_or_else(|| io::Error::other("No probe address"))?;
        if address.ip().is_unspecified() {
            address.set_ip(match address.ip() {
                IpAddr::V4(_) => IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
                IpAddr::V6(_) => IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
            });
        }
        let mut stream = tokio::net::TcpStream::connect(address).await?;
        stream
            .write_all(
                b"GET /api/v1/ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .await?;
        let mut status = [0; 13];
        stream.read_exact(&mut status).await?;
        if &status != b"HTTP/1.1 200 " && &status != b"HTTP/1.0 200 " {
            return Err(io::Error::other("Not ready"));
        }
        Ok(())
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Probe timed out"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn probe_requests_readiness_and_requires_http_200() {
        for (response, healthy) in [
            ("HTTP/1.1 200 OK\r\n\r\nok", true),
            ("HTTP/1.0 200 OK\r\n\r\nok", true),
            ("HTTP/1.1 503 Service Unavailable\r\n\r\n", false),
            ("HTTP/1.1 500 Internal Server Error\r\n\r\n", false),
            ("HTTP/1.1 2000 invalid\r\n\r\n", false),
            ("", false),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                const EXPECTED: &[u8] =
                    b"GET /api/v1/ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
                let mut request = [0; EXPECTED.len()];
                stream.read_exact(&mut request).await.unwrap();
                assert_eq!(&request, EXPECTED);
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            // Wildcard binds are probed via loopback, on the configured port.
            assert_eq!(run(&format!("0.0.0.0:{port}")).await.is_ok(), healthy);
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn probe_bounds_an_unresponsive_server() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let result = tokio::time::timeout(Duration::from_secs(2), run(&address))
            .await
            .expect("probe must enforce its own deadline");
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        server.abort();
    }
}
