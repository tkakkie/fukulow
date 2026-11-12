use sqlx::{PgPool, postgres::PgSslMode};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
    task::JoinSet,
};

/// Execute a statement on PostgreSQL, withhold its response, then cancel its owner.
/// The same test exercises the unknown-BEGIN-depth gap in SQLx and in-flight cleanup.
pub(crate) async fn at(
    admin: &PgPool,
    app: &PgPool,
    statement: &str,
    work: impl AsyncFnOnce(&PgPool) -> Result<(), sqlx::Error>,
) {
    tokio::time::timeout(Duration::from_secs(15), async {
        let options = app.connect_options();
        let upstream = (options.get_host().to_owned(), options.get_port());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (hold, gate) = watch::channel(false);
        let needle = statement.as_bytes().to_vec();
        let request_hold = hold.clone();
        let armed = Arc::new(AtomicBool::new(true));
        let mut relays = JoinSet::new();
        relays.spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                let (mut client, _) = listener.accept().await.unwrap();
                let mut server = TcpStream::connect((upstream.0.as_str(), upstream.1))
                    .await
                    .unwrap();
                let mut gate = gate.clone();
                let hold = request_hold.clone();
                let needle = needle.clone();
                let armed = armed.clone();
                connections.spawn(async move {
                    let pending_hold = AtomicBool::new(false);
                    let (mut client_read, mut client_write) = client.split();
                    let (mut server_read, mut server_write) = server.split();
                    let requests = async {
                        let mut bytes = [0; 8192];
                        let mut tail = Vec::new();
                        loop {
                            let count = client_read.read(&mut bytes).await?;
                            if count == 0 { return Ok::<_, std::io::Error>(()); }
                            tail.extend_from_slice(&bytes[..count]);
                            // Parse may be a separate round trip from Execute. Only
                            // withhold CommandComplete, after the statement really ran.
                            if tail.windows(needle.len()).any(|window| window == needle)
                                && armed.swap(false, Ordering::SeqCst)
                            {
                                pending_hold.store(true, Ordering::SeqCst);
                            }
                            server_write.write_all(&bytes[..count]).await?;
                            if tail.len() > needle.len() {
                                tail.drain(..tail.len() - needle.len());
                            }
                        }
                    };
                    let responses = async {
                        let mut bytes = [0; 8192];
                        let mut frames = Vec::new();
                        loop {
                            let count = server_read.read(&mut bytes).await?;
                            if count == 0 { return Ok::<_, std::io::Error>(()); }
                            frames.extend_from_slice(&bytes[..count]);
                            while frames.len() >= 5 {
                                let length = 1 + u32::from_be_bytes([
                                    frames[1], frames[2], frames[3], frames[4],
                                ]) as usize;
                                if frames.len() < length { break; }
                                if frames[0] == b'C' && pending_hold.swap(false, Ordering::SeqCst) {
                                    let _ = hold.send(true);
                                }
                                while *gate.borrow_and_update() {
                                    if gate.changed().await.is_err() { return Ok(()); }
                                }
                                client_write.write_all(&frames[..length]).await?;
                                frames.drain(..length);
                            }
                        }
                    };
                    tokio::select! {
                        _ = requests => {}
                        _ = responses => {}
                    }
                });
                while connections.try_join_next().is_some() {}
            }
        });
        let single = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .test_before_acquire(false)
            .connect_with(options.as_ref().clone().host("127.0.0.1").port(address.port())
                .ssl_mode(PgSslMode::Disable))
            .await.unwrap();
        let mut connection = single.acquire().await.unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *connection).await.unwrap();
        connection.return_to_pool().await;
        drop(connection);
        let mut pending = Box::pin(work(&single));
        let executed = async {
            loop {
                let executed: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT FROM pg_stat_activity WHERE pid = $1 AND query = $2 \
                     AND state IN ('idle in transaction', 'idle'))",
                ).bind(pid).bind(statement).fetch_one(admin).await.unwrap();
                if executed && *hold.borrow() { break; }
                tokio::task::yield_now().await;
            }
        };
        tokio::select! {
            result = &mut pending => panic!("response escaped the relay gate ({statement}): {result:?}"),
            () = executed => {}
        }
        drop(pending);
        hold.send(false).unwrap();
        let next_pid = super::context::clean(&single).await;
        assert_ne!(next_pid, pid, "interrupted {statement} must discard the connection");
        single.close().await;
        drop(relays);
    }).await.expect("interrupted transaction recovery must not hang");
}
