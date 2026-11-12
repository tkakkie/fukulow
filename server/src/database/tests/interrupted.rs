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

/// Fail ROLLBACK after PostgreSQL has completed it, without killing the backend.
/// The control proves SQLx's health check reuses this exact error/connection;
/// only the transaction owner's explicit discard can change the PID afterward.
pub(crate) async fn failed_rollback(app: &PgPool, work: impl AsyncFnOnce(&PgPool, i32)) {
    tokio::time::timeout(Duration::from_secs(15), async {
        let options = app.connect_options();
        let upstream = (options.get_host().to_owned(), options.get_port());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let armed = Arc::new(AtomicBool::new(true));
        let relay_armed = armed.clone();
        let mut relays = JoinSet::new();
        relays.spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                let (mut client, _) = listener.accept().await.unwrap();
                let mut server = TcpStream::connect((upstream.0.as_str(), upstream.1))
                    .await
                    .unwrap();
                let armed = relay_armed.clone();
                connections.spawn(async move {
                    // SSL is disabled below, so the first frame is StartupMessage.
                    let length = client.read_u32().await?;
                    let mut startup = vec![0; length as usize - 4];
                    client.read_exact(&mut startup).await?;
                    server.write_u32(length).await?;
                    server.write_all(&startup).await?;
                    let (mut client_read, mut client_write) = client.split();
                    let (mut server_read, mut server_write) = server.split();
                    let requests = async {
                        loop {
                            let Ok(tag) = client_read.read_u8().await else {
                                break Ok::<(), std::io::Error>(());
                            };
                            let length = client_read.read_u32().await?;
                            let mut payload = vec![0; length as usize - 4];
                            client_read.read_exact(&mut payload).await?;
                            if tag == b'Q' && payload == b"ROLLBACK\0"
                                && armed.swap(false, Ordering::SeqCst)
                            {
                                payload = b"ROLLBACK; SELECT 1 / 0\0".to_vec();
                            }
                            server_write.write_u8(tag).await?;
                            server_write.write_u32(payload.len() as u32 + 4).await?;
                            server_write.write_all(&payload).await?;
                        }
                    };
                    tokio::select! {
                        result = requests => result,
                        result = tokio::io::copy(&mut server_read, &mut client_write) => result.map(|_| ()),
                    }
                });
                while connections.try_join_next().is_some() {}
            }
        });
        let single = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect_with(options.as_ref().clone().host("127.0.0.1").port(address.port())
                .ssl_mode(PgSslMode::Disable))
            .await.unwrap();
        let mut connection = single.acquire().await.unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *connection).await.unwrap();
        sqlx::Executor::execute(&mut *connection, "BEGIN").await.unwrap();
        let error = sqlx::Executor::execute(&mut *connection, "ROLLBACK").await.unwrap_err();
        assert_eq!(error.as_database_error().unwrap().code().as_deref(), Some("22012"));
        assert!(!armed.load(Ordering::SeqCst), "control must inject the cleanup error");
        connection.return_to_pool().await;
        drop(connection);
        assert_eq!(super::context::clean(&single).await, pid,
            "SQLx must reuse the live backend after the control's cleanup error");
        armed.store(true, Ordering::SeqCst);
        work(&single, pid).await;
        assert!(!armed.load(Ordering::SeqCst), "owner must encounter the cleanup error");
        single.close().await;
        drop(relays);
    }).await.expect("failed rollback recovery must not hang");
}
