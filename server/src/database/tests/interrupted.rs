use crate::database::test_support::clean;
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
pub(crate) async fn at<E: std::fmt::Debug>(
    admin: &PgPool,
    app: &PgPool,
    statement: &str,
    work: impl AsyncFnOnce(&PgPool) -> Result<(), E>,
) {
    interrupted(admin, app, statement, None, work).await;
}

/// Keep the response stalled through the owner's deadline and replacement acquire.
pub(crate) async fn at_deadline(
    admin: &PgPool,
    app: &PgPool,
    statement: &str,
    work: impl AsyncFnOnce(&PgPool) -> Result<(), crate::database::InternalError>,
) {
    interrupted(
        admin,
        app,
        statement,
        Some(|result| {
            assert!(matches!(
                result,
                Err(crate::database::InternalError::Deadline)
            ));
        }),
        work,
    )
    .await;
}

async fn interrupted<E: std::fmt::Debug>(
    admin: &PgPool,
    app: &PgPool,
    statement: &str,
    check_deadline: Option<fn(Result<(), E>)>,
    work: impl AsyncFnOnce(&PgPool) -> Result<(), E>,
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
                                    while *gate.borrow_and_update() {
                                        if gate.changed().await.is_err() { return Ok(()); }
                                    }
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
        if let Some(check_deadline) = check_deadline {
            check_deadline(pending.await);
            assert_eq!(single.size(), 0, "deadline must free the permit before graceful cleanup");
        } else {
            drop(pending);
            hold.send(false).unwrap();
        }
        // 3 s covers a fresh connect+auth on a loaded runner and stays below SQLx's
        // 5 s graceful-close hold, so a regressed (retained) slot still times out.
        let next_pid = tokio::time::timeout(Duration::from_secs(3), clean(&single))
            .await.expect("replacement acquire must succeed while the old transport stays stalled");
        assert_ne!(next_pid, pid, "interrupted {statement} must discard the connection");
        hold.send(false).unwrap();
        single.close().await;
        drop(relays);
    }).await.expect("interrupted transaction recovery must not hang");
}

/// Fail ROLLBACK after PostgreSQL has completed it, without killing the backend.
/// The control proves SQLx's health check reuses this exact error/connection;
/// only the transaction owner's explicit discard can change the PID afterward.
pub(crate) async fn failed_rollback(app: &PgPool, work: impl AsyncFnOnce(&PgPool, i32)) {
    tokio::time::timeout(Duration::from_secs(15), async {
        let armed = Arc::new(AtomicBool::new(true));
        let (single, relays) =
            rewriting(app, "ROLLBACK", "ROLLBACK; SELECT 1 / 0", armed.clone()).await;
        let mut connection = single.acquire().await.unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
        sqlx::Executor::execute(&mut *connection, "BEGIN")
            .await
            .unwrap();
        let error = sqlx::Executor::execute(&mut *connection, "ROLLBACK")
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("22012")
        );
        assert!(
            !armed.load(Ordering::SeqCst),
            "control must inject the cleanup error"
        );
        connection.return_to_pool().await;
        drop(connection);
        assert_eq!(
            clean(&single).await,
            pid,
            "SQLx must reuse the live backend after the control's cleanup error"
        );
        armed.store(true, Ordering::SeqCst);
        work(&single, pid).await;
        assert!(
            !armed.load(Ordering::SeqCst),
            "owner must encounter the cleanup error"
        );
        single.close().await;
        drop(relays);
    })
    .await
    .expect("failed rollback recovery must not hang");
}

/// Replace the transaction-opening simple Query `start` with `failing`, which
/// opens the transaction and then fails in it. The control proves SQLx hands the
/// same backend, still inside the failed transaction, to the next acquire; only
/// the owner's explicit discard can change the PID afterward.
pub(crate) async fn failed_start(
    app: &PgPool,
    start: &str,
    failing: &str,
    work: impl AsyncFnOnce(&PgPool, i32),
) {
    tokio::time::timeout(Duration::from_secs(15), async {
        let armed = Arc::new(AtomicBool::new(true));
        let (single, relays) = rewriting(app, start, failing, armed.clone()).await;
        let mut connection = single.acquire().await.unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
        let error = sqlx::Executor::execute(&mut *connection, start)
            .await
            .unwrap_err();
        assert!(error.as_database_error().is_some(), "{error:?}");
        assert!(
            !armed.load(Ordering::SeqCst),
            "control must inject the start error"
        );
        connection.return_to_pool().await;
        drop(connection);
        let mut reused = single.acquire().await.unwrap();
        let aborted = sqlx::Executor::execute(&mut *reused, "SELECT 1")
            .await
            .unwrap_err();
        assert_eq!(
            aborted.as_database_error().unwrap().code().as_deref(),
            Some("25P02"),
            "SQLx must hand out the backend still in the failed transaction"
        );
        sqlx::Executor::execute(&mut *reused, "ROLLBACK")
            .await
            .unwrap();
        drop(reused);
        assert_eq!(clean(&single).await, pid);
        armed.store(true, Ordering::SeqCst);
        work(&single, pid).await;
        assert!(
            !armed.load(Ordering::SeqCst),
            "owner must encounter the start error"
        );
        single.close().await;
        drop(relays);
    })
    .await
    .expect("failed start recovery must not hang");
}

/// A one-connection pool whose relay rewrites the next armed simple Query
/// `query` to `replacement`.
async fn rewriting(
    app: &PgPool,
    query: &str,
    replacement: &str,
    armed: Arc<AtomicBool>,
) -> (PgPool, JoinSet<()>) {
    let options = app.connect_options();
    let upstream = (options.get_host().to_owned(), options.get_port());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let query = [query.as_bytes(), b"\0"].concat();
    let replacement = [replacement.as_bytes(), b"\0"].concat();
    let mut relays = JoinSet::new();
    relays.spawn(async move {
        let mut connections = JoinSet::new();
        loop {
            let (mut client, _) = listener.accept().await.unwrap();
            let mut server = TcpStream::connect((upstream.0.as_str(), upstream.1))
                .await
                .unwrap();
            let (armed, query, replacement) = (armed.clone(), query.clone(), replacement.clone());
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
                        if tag == b'Q' && payload == query && armed.swap(false, Ordering::SeqCst) {
                            payload = replacement.clone();
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
        .connect_with(
            options
                .as_ref()
                .clone()
                .host("127.0.0.1")
                .port(address.port())
                .ssl_mode(PgSslMode::Disable),
        )
        .await
        .unwrap();
    (single, relays)
}

/// Withhold ParseComplete for the statement containing `needle` while `during`
/// runs. On a statement-cache miss SQLx sends Bind and Execute only after that
/// response, so `during` commits between Parse and execution.
pub(crate) async fn paused_after_parse<T: std::fmt::Debug>(
    app: &PgPool,
    needle: &str,
    work: impl AsyncFnOnce(&PgPool) -> T,
    during: impl AsyncFnOnce(),
) -> T {
    tokio::time::timeout(Duration::from_secs(15), async {
        let options = app.connect_options();
        let upstream = (options.get_host().to_owned(), options.get_port());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (parsed, mut parsed_rx) = watch::channel(false);
        let (release, gate) = watch::channel(false);
        let needle = needle.as_bytes().to_vec();
        let armed = Arc::new(AtomicBool::new(true));
        let mut relays = JoinSet::new();
        relays.spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                let (mut client, _) = listener.accept().await.unwrap();
                let mut server = TcpStream::connect((upstream.0.as_str(), upstream.1))
                    .await
                    .unwrap();
                let (parsed, mut gate) = (parsed.clone(), gate.clone());
                let (needle, armed) = (needle.clone(), armed.clone());
                connections.spawn(async move {
                    let pending = AtomicBool::new(false);
                    let (mut client_read, mut client_write) = client.split();
                    let (mut server_read, mut server_write) = server.split();
                    let requests = async {
                        let mut bytes = [0; 8192];
                        let mut tail = Vec::new();
                        loop {
                            let count = client_read.read(&mut bytes).await?;
                            if count == 0 { return Ok::<_, std::io::Error>(()); }
                            tail.extend_from_slice(&bytes[..count]);
                            if tail.windows(needle.len()).any(|window| window == needle)
                                && armed.swap(false, Ordering::SeqCst)
                            {
                                pending.store(true, Ordering::SeqCst);
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
                                // ParseComplete: the Parse has run on the server.
                                if frames[0] == b'1' && pending.swap(false, Ordering::SeqCst) {
                                    let _ = parsed.send(true);
                                    while !*gate.borrow_and_update() {
                                        if gate.changed().await.is_err() { return Ok(()); }
                                    }
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
            .connect_with(options.as_ref().clone().host("127.0.0.1").port(address.port())
                .ssl_mode(PgSslMode::Disable))
            .await.unwrap();
        let mut pending = Box::pin(work(&single));
        tokio::select! {
            result = &mut pending => panic!("statement finished without a paused Parse: {result:?}"),
            _ = parsed_rx.wait_for(|parsed| *parsed) => {}
        }
        during().await;
        release.send(true).unwrap();
        let result = pending.await;
        single.close().await;
        drop(relays);
        result
    }).await.expect("paused Parse must not hang")
}
