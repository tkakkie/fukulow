//! #196 A: socket caps, control-frame budget, duplicate subscribe.
use super::*;
use crate::realtime::{Budget, SocketGate, SocketLimits};

fn limits(per_account: usize, global: usize, connection: u64, account: u64) -> SocketLimits {
    SocketLimits {
        per_account,
        global,
        connection_frames: Budget {
            burst: connection,
            per_second: 1,
        },
        account_frames: Budget {
            burst: account,
            per_second: 1,
        },
        read_buffer: 4096,
    }
}

async fn limited(pool: &PgPool, limits: SocketLimits) -> Fixture {
    let mut f = fixture(pool).await;
    f.state.socket_gate = SocketGate::new(limits);
    f.app = crate::app(f.state.clone());
    f.server = Server::start(f.app.clone()).await;
    f
}

/// Another Organization's Membership and a second Account Session of `member`'s Account.
async fn second_membership(pool: &PgPool, member: Uuid) -> String {
    let organization = organization(pool).await;
    let account: Uuid = sqlx::query_scalar("SELECT account_id FROM users WHERE id = $1")
        .bind(member)
        .fetch_one(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (organization_id, id, account_id, name, role) VALUES ($1, $2, $3, 'Member', 'member')")
        .bind(organization).bind(Uuid::new_v4()).bind(account).execute(pool).await.unwrap();
    let token = format!(
        "{organization}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    sqlx::query("INSERT INTO account_sessions (token_hash, account_id) VALUES ($1, $2)")
        .bind(Sha256::digest(token.as_bytes()).to_vec())
        .bind(account)
        .execute(pool)
        .await
        .unwrap();
    token
}

fn refused(result: Result<Client, tungstenite::Error>) {
    let Err(tungstenite::Error::Http(response)) = result else {
        panic!("expected HTTP denial");
    };
    assert_eq!(response.status(), 503);
    let retry: u64 = response.headers()[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=5).contains(&retry));
    let body: Value = serde_json::from_slice(response.body().as_ref().unwrap()).unwrap();
    assert_eq!(body, json!({"error":"socket_limit"}));
}

async fn open_sockets(f: &Fixture, expected: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while f.state.socket_gate.open().0 != expected {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("expected {expected} open sockets"));
}

async fn text(client: &mut Client, text: &str) {
    client.send(tungstenite::Message::text(text)).await.unwrap();
}

#[fukulow_test::test]
async fn the_account_cap_counts_every_organization_and_session_and_refuses_with_503(pool: PgPool) {
    let f = limited(&pool, limits(2, 100, 50, 50)).await;
    let other_organization = second_membership(&pool, f.member).await;
    let mut first = f.server.connect(&f.token).await;
    let _second = f.server.connect(&other_organization).await;
    refused(f.server.handshake(Some(&f.token), None, None).await);
    refused(
        f.server
            .handshake(Some(&other_organization), None, None)
            .await,
    );
    // Another Account is not affected by this Account's cap.
    let (_, stranger) = member(&pool, f.organization).await;
    let _stranger = f.server.connect(&stranger).await;
    // The refused sockets took nothing; closing one frees exactly one slot.
    open_sockets(&f, 3).await;
    first.close(None).await.unwrap();
    open_sockets(&f, 2).await;
    let mut again = f.server.connect(&f.token).await;
    subscribe(&mut again, f.channel, 0).await;
    ready(&mut again, f.channel, 0).await;
}

#[fukulow_test::test]
async fn the_global_cap_refuses_every_account_until_a_socket_closes(pool: PgPool) {
    let f = limited(&pool, limits(5, 2, 50, 50)).await;
    let (_, other) = member(&pool, f.organization).await;
    let _first = f.server.connect(&f.token).await;
    let second = f.server.connect(&other).await;
    refused(f.server.handshake(Some(&f.token), None, None).await);
    refused(f.server.handshake(Some(&other), None, None).await);
    drop(second);
    open_sockets(&f, 1).await;
    let _third = f.server.connect(&other).await;
}

#[fukulow_test::test]
async fn slots_are_released_on_every_path(pool: PgPool) {
    let f = limited(&pool, limits(1, 100, 1, 50)).await;
    // Authentication failure takes no slot.
    rejected(f.server.handshake(Some("bad.token"), None, None).await, 401);
    open_sockets(&f, 0).await;
    // Normal client close.
    let mut socket = f.server.connect(&f.token).await;
    socket.close(None).await.unwrap();
    open_sockets(&f, 0).await;
    // Connection dropped without a Close frame.
    drop(f.server.connect(&f.token).await);
    open_sockets(&f, 0).await;
    // Server-side error close (4029 after the one-frame budget).
    let mut socket = f.server.connect(&f.token).await;
    text(&mut socket, "one").await;
    assert_eq!(event(&mut socket).await["code"], "invalid_input");
    text(&mut socket, "two").await;
    closed(&mut socket, CLOSE_RATE_LIMITED).await;
    open_sockets(&f, 0).await;
    // A handshake answered 101 whose client vanishes before using the socket.
    let mut tcp = TcpStream::connect(f.server.address).await.unwrap();
    let path = scoped_path("/api/v1/ws", &f.token);
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {}\r\n\r\n",
        f.server.address,
        f.token,
        tungstenite::handshake::client::generate_key()
    );
    tokio::io::AsyncWriteExt::write_all(&mut tcp, request.as_bytes())
        .await
        .unwrap();
    let mut head = [0u8; 12];
    tokio::io::AsyncReadExt::read_exact(&mut tcp, &mut head)
        .await
        .unwrap();
    assert_eq!(&head, b"HTTP/1.1 101");
    drop(tcp);
    open_sockets(&f, 0).await;
    // Server shutdown cancels the connection task.
    let mut socket = f.server.connect(&f.token).await;
    subscribe(&mut socket, f.channel, 0).await;
    ready(&mut socket, f.channel, 0).await;
    f.state.shutdown.begin();
    closed(&mut socket, 1001).await;
    open_sockets(&f, 0).await;
}

#[fukulow_test::test]
async fn over_budget_frames_close_4029_before_any_database_access(pool: PgPool) {
    let f = limited(&pool, limits(5, 100, 2, 50)).await;
    let mut socket = f.server.connect(&f.token).await;
    // Malformed text and binary frames are charged too.
    text(&mut socket, "not json").await;
    assert_eq!(event(&mut socket).await["code"], "invalid_input");
    socket
        .send(tungstenite::Message::binary(vec![1, 2, 3]))
        .await
        .unwrap();
    assert_eq!(event(&mut socket).await["code"], "invalid_input");
    // Every application connection is busy: a subscribe that reached the database
    // would wait for the pool, but the refusal answers at once.
    let max = f.state.pool.options().get_max_connections();
    let mut held = Vec::new();
    for _ in 0..max {
        held.push(f.state.pool.acquire().await.unwrap());
    }
    subscribe(&mut socket, f.channel, 0).await;
    closed(&mut socket, CLOSE_RATE_LIMITED).await;
    drop(held);
}

#[fukulow_test::test]
async fn unsubscribe_subscribe_cycling_cannot_bypass_the_budget(pool: PgPool) {
    let f = limited(&pool, limits(5, 100, 5, 50)).await;
    let mut socket = f.server.connect(&f.token).await;
    subscribe(&mut socket, f.channel, 0).await;
    ready(&mut socket, f.channel, 0).await;
    for _ in 0..2 {
        control(
            &mut socket,
            ClientMessage::Unsubscribe {
                channel_id: f.channel,
            },
        )
        .await
        .unwrap();
        subscribe(&mut socket, f.channel, 0).await;
        ready(&mut socket, f.channel, 0).await;
    }
    control(
        &mut socket,
        ClientMessage::Unsubscribe {
            channel_id: f.channel,
        },
    )
    .await
    .unwrap();
    closed(&mut socket, CLOSE_RATE_LIMITED).await;
}

#[fukulow_test::test]
async fn a_duplicate_subscribe_is_a_charged_no_op_whatever_its_after_seq(pool: PgPool) {
    let f = limited(&pool, limits(5, 100, 4, 50)).await;
    let first = post(&f, f.channel).await;
    let second = post(&f, f.channel).await;
    let mut socket = f.server.connect(&f.token).await;
    subscribe(&mut socket, f.channel, 0).await;
    assert_eq!(event(&mut socket).await["message"], first);
    assert_eq!(event(&mut socket).await["message"], second);
    ready(&mut socket, f.channel, 2).await;
    // No authorization query, watermark or replay, and no reply, even for an
    // after_seq that a new subscription would refuse.
    subscribe(&mut socket, f.channel, 1).await;
    subscribe(&mut socket, f.channel, -1).await;
    silent(&mut socket).await;
    let live = post(&f, f.channel).await;
    assert_eq!(event(&mut socket).await["message"], live);
    silent(&mut socket).await;
    // Duplicates still consume the budget: this is the fifth frame.
    subscribe(&mut socket, f.channel, 0).await;
    subscribe(&mut socket, f.channel, 0).await;
    closed(&mut socket, CLOSE_RATE_LIMITED).await;
}

#[fukulow_test::test]
async fn reconnecting_after_4029_does_not_reset_the_account_budget(pool: PgPool) {
    // No Account refill, so the refusals below cannot race a refill; refill is
    // covered by the limiter unit tests.
    let mut no_refill = limits(5, 100, 100, 6);
    no_refill.account_frames.per_second = 0;
    let f = limited(&pool, no_refill).await;
    let session = second_membership(&pool, f.member).await;
    let mut socket = f.server.connect(&f.token).await;
    let mut subscribed = 0;
    loop {
        subscribe(&mut socket, f.channel, 0).await;
        match frame(&mut socket).await {
            tungstenite::Message::Text(text) => {
                let reply: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(reply["type"], "subscribed");
                subscribed += 1;
                let unsubscribe = ClientMessage::Unsubscribe {
                    channel_id: f.channel,
                };
                control(&mut socket, unsubscribe).await.unwrap();
            }
            tungstenite::Message::Close(Some(close)) => {
                assert_eq!(u16::from(close.code), CLOSE_RATE_LIMITED);
                break;
            }
            frame => panic!("unexpected frame {frame:?}"),
        }
    }
    // Six tokens, two per subscribe/unsubscribe cycle.
    assert_eq!(subscribed, 3);
    // The exhausted Account is refused before the upgrade, whatever its Session.
    open_sockets(&f, 0).await;
    refused(f.server.handshake(Some(&f.token), None, None).await);
    refused(f.server.handshake(Some(&session), None, None).await);
    assert_eq!(f.state.socket_gate.open(), (0, 1));
    // Another Account is unaffected.
    let other = fixture(&pool).await;
    let mut unaffected = f.server.connect(&other.token).await;
    subscribe(&mut unaffected, other.channel, 0).await;
    ready(&mut unaffected, other.channel, 0).await;
}

fn unlimited(read_buffer: usize) -> SocketLimits {
    let budget = Budget {
        burst: u64::MAX / 2000,
        per_second: 1,
    };
    SocketLimits {
        per_account: usize::MAX,
        global: usize::MAX,
        connection_frames: budget,
        account_frames: budget,
        read_buffer,
    }
}

// RSS and CPU include the in-process loopback clients (each with tungstenite's
// 128 KiB default read buffer), so compare server read-buffer variants by difference.
#[fukulow_test::test]
#[ignore = "manual release idle-socket RSS/CPU by server read buffer (#196 A)"]
async fn measure_idle_socket_rss_by_read_buffer(pool: PgPool) {
    let env = |name: &str, default: usize| -> usize {
        std::env::var(name).map_or(default, |v| v.parse().unwrap())
    };
    let count = env("MEASURE_SOCKETS", 10_000);
    let read_buffer = env("MEASURE_READ_BUFFER", 128 * 1024);
    let f = limited(&pool, unlimited(read_buffer)).await;
    let mut clients = tokio::task::JoinSet::new();
    for index in 0..count {
        let mut socket = f.server.connect(&f.token).await;
        subscribe(&mut socket, f.channel, 0).await;
        ready(&mut socket, f.channel, 0).await;
        clients.spawn(async move {
            while let Some(Ok(frame)) = socket.next().await {
                if let tungstenite::Message::Ping(_) = frame {
                    let _ = socket.flush().await;
                }
            }
        });
        if (index + 1).is_multiple_of(2000) {
            eprintln!("prepared {} sockets", index + 1);
        }
    }
    // Spawning `ps` here fails (EBADF) with ~20k open descriptors: the runner samples
    // this process's RSS and CPU time from outside during the idle window.
    eprintln!(
        "MEASURE ready read_buffer={read_buffer} sockets={count} pid={}",
        std::process::id()
    );
    tokio::time::sleep(Duration::from_secs(30)).await;
    clients.abort_all();
}

// MEASURE_FLOODERS sockets of one Account loop subscribe/unsubscribe as fast as
// possible; on 4029 each reconnects at once (ignoring backoff). Meanwhile another
// Organization's Member re-subscribes every 500 ms (1 s deadline), and the app pool's
// in-use connections are sampled every 5 ms. Runs for MEASURE_SECONDS.
#[fukulow_test::test]
#[ignore = "manual release 4029 reconnect-loop subscribe load (#196 A)"]
async fn measure_reconnect_flood_subscribe_load(pool: PgPool) {
    let env = |name: &str, default: u64| -> u64 {
        std::env::var(name).map_or(default, |v| v.parse().unwrap())
    };
    let seconds = Duration::from_secs(env("MEASURE_SECONDS", 30));
    let flooders = env("MEASURE_FLOODERS", 8);
    let budget = std::env::var("MEASURE_UNLIMITED").is_err();
    let limits = if budget {
        SocketLimits::default()
    } else {
        unlimited(SocketLimits::default().read_buffer)
    };
    let f = limited(&pool, limits).await;
    let other = fixture(&pool).await;
    let started = std::time::Instant::now();
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..flooders {
        let (address, token, channel) = (f.server.address, f.token.clone(), f.channel);
        tasks.spawn(async move {
            let (mut subscribes, mut connections, mut refusals) = (0u64, 0u64, 0u64);
            while started.elapsed() < seconds {
                let Ok(mut socket) = try_connect_at(address, &token).await else {
                    refusals += 1;
                    continue;
                };
                connections += 1;
                while started.elapsed() < seconds {
                    let subscribe = ClientMessage::Subscribe {
                        channel_id: channel,
                        after_seq: 0,
                    };
                    if control(&mut socket, subscribe).await.is_err() {
                        break;
                    }
                    // A Close, a reset or a timeout all end this socket: reconnect.
                    match tokio::time::timeout(Duration::from_secs(5), socket.next()).await {
                        Ok(Some(Ok(tungstenite::Message::Text(_)))) => subscribes += 1,
                        _ => break,
                    }
                    let unsubscribe = ClientMessage::Unsubscribe {
                        channel_id: channel,
                    };
                    if control(&mut socket, unsubscribe).await.is_err() {
                        break;
                    }
                }
            }
            (subscribes, connections, refusals, 0u64, 0u64, Vec::new())
        });
    }
    let (address, token, channel) = (f.server.address, other.token.clone(), other.channel);
    tasks.spawn(async move {
        let mut socket = connect_at(address, &token).await;
        let (mut ok, mut failed, mut latencies) = (0u64, 0u64, Vec::new());
        while started.elapsed() < seconds {
            let at = std::time::Instant::now();
            let unsubscribe = ClientMessage::Unsubscribe {
                channel_id: channel,
            };
            let subscribe = ClientMessage::Subscribe {
                channel_id: channel,
                after_seq: 0,
            };
            let sent = control(&mut socket, unsubscribe).await.is_ok()
                && control(&mut socket, subscribe).await.is_ok();
            let answer = tokio::time::timeout(Duration::from_secs(1), socket.next()).await;
            match answer {
                Ok(Some(Ok(tungstenite::Message::Text(text))))
                    if sent && text.contains("subscribed") =>
                {
                    ok += 1;
                    latencies.push(at.elapsed().as_secs_f64() * 1000.0);
                }
                _ => {
                    failed += 1;
                    socket = connect_at(address, &token).await;
                }
            }
            // Two frames per probe stay within the 4/s connection refill.
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        (0, 0, 0, ok, failed, latencies)
    });
    let app_pool = f.state.pool.clone();
    let sampler = tokio::spawn(async move {
        let mut peak = 0u32;
        while started.elapsed() < seconds {
            peak = peak.max(app_pool.size() - app_pool.num_idle() as u32);
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        peak
    });
    let (mut subscribes, mut connections, mut refusals, mut ok, mut failed, mut latencies) =
        (0, 0, 0, 0, 0, Vec::new());
    while let Some(result) = tasks.join_next().await {
        let (s, c, r, o, x, l) = result.unwrap();
        (subscribes, connections, refusals, ok, failed) = (
            subscribes + s,
            connections + c,
            refusals + r,
            ok + o,
            failed + x,
        );
        latencies.extend(l);
    }
    let peak = sampler.await.unwrap();
    latencies.sort_by(f64::total_cmp);
    let p = |q: f64| {
        latencies
            .get(((latencies.len() as f64 - 1.0) * q) as usize)
            .copied()
    };
    let elapsed = started.elapsed().as_secs_f64();
    eprintln!(
        "MEASURE budget={budget} flooders={flooders} seconds={elapsed:.1} connections={connections} refusals={refusals} \
         subscribes={subscribes} per_second={:.1} pool_in_use_peak={peak} \
         other_org ok={ok} failed={failed} p50_ms={:?} p99_ms={:?}",
        subscribes as f64 / elapsed,
        p(0.5),
        p(0.99)
    );
}
