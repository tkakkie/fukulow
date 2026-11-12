use std::{
    future::Future,
    io,
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) fn execute(address: &str) -> io::Result<()> {
    with_runtime(run(address))
}

fn with_runtime(work: impl Future<Output = io::Result<()>>) -> io::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(work);
    // lookup_host uses blocking resolver work which cannot be cancelled. The
    // standalone probe must exit without waiting for that work after its deadline.
    runtime.shutdown_background();
    result
}

async fn run(address: &str) -> io::Result<()> {
    run_with_resolver(async {
        tokio::net::lookup_host(address)
            .await
            .map(|addresses| addresses.collect())
    })
    .await
}

async fn run_with_resolver(
    resolve: impl Future<Output = io::Result<Vec<SocketAddr>>>,
) -> io::Result<()> {
    tokio::time::timeout(Duration::from_secs(1), async {
        let mut error = io::Error::other("No probe address");
        for address in resolve.await? {
            match request(address).await {
                Ok(()) => return Ok(()),
                Err(failed) => error = failed,
            }
        }
        Err(error)
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Probe timed out"))?
}

async fn request(mut address: SocketAddr) -> io::Result<()> {
    if address.ip().is_unspecified() {
        address.set_ip(match address.ip() {
            IpAddr::V4(_) => IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            IpAddr::V6(_) => IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
        });
    }
    let mut stream = tokio::net::TcpStream::connect(address).await?;
    stream
        .write_all(b"GET /api/v1/ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await?;
    let mut status = [0; 13];
    stream.read_exact(&mut status).await?;
    if &status != b"HTTP/1.1 200 " && &status != b"HTTP/1.0 200 " {
        return Err(io::Error::other("Not ready"));
    }
    Ok(())
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

    #[tokio::test]
    async fn probe_tries_alternate_addresses_after_connection_failure() {
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let first = closed.local_addr().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let second = listener.local_addr().unwrap();
        drop(closed);
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0;
                b"GET /api/v1/ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".len()];
            stream.read_exact(&mut request).await.unwrap();
            stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
        });
        run_with_resolver(async { Ok(vec![first, second]) })
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[test]
    fn probe_subprocess_exits_despite_stalled_resolver() {
        const CHILD: &str = "FUKULOW_TEST_STALLED_RESOLVER";
        if std::env::var_os(CHILD).is_some() {
            let result = with_runtime(run_with_resolver(async {
                let (started, waiting) = tokio::sync::oneshot::channel();
                tokio::task::spawn_blocking(move || {
                    let _ = started.send(());
                    std::thread::sleep(Duration::from_secs(30));
                });
                waiting.await.unwrap();
                std::future::pending().await
            }));
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
            return;
        }
        let started = std::time::Instant::now();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .env_clear()
            .env(CHILD, "1")
            .args([
                "--exact",
                "probe::tests::probe_subprocess_exits_despite_stalled_resolver",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                assert!(started.elapsed() >= Duration::from_millis(900));
                break;
            }
            if started.elapsed() > Duration::from_secs(3) {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("probe subprocess waited for stalled blocking resolver");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
