use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// Count frontend request/response boundaries (simple Query, extended Sync and
// prepare Flush), not TCP packets. SSL is disabled only on this local test relay.
#[fukulow_test::test]
#[ignore = "manual subscription wire round-trip comparison"]
async fn measure_subscription_round_trips(pool: PgPool) {
    let options = pool.connect_options();
    let upstream = (options.get_host().to_owned(), options.get_port());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let prepares = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let executions = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let execution_counter = executions.clone();
    let prepare_counter = prepares.clone();
    let counter = count.clone();
    let mut relays = tokio::task::JoinSet::new();
    relays.spawn(async move {
        let mut clients = tokio::task::JoinSet::new();
        loop {
            let (mut client, _) = listener.accept().await.unwrap();
            let mut server = TcpStream::connect((upstream.0.as_str(), upstream.1))
                .await
                .unwrap();
            let counter = counter.clone();
            let prepares = prepare_counter.clone();
            let executions = execution_counter.clone();
            clients.spawn(async move {
                let (mut cr, mut cw) = client.split();
                let (mut sr, mut sw) = server.split();
                let requests = async {
                    let size = cr.read_u32().await?;
                    let mut startup = vec![0; size as usize - 4];
                    cr.read_exact(&mut startup).await?;
                    sw.write_u32(size).await?;
                    sw.write_all(&startup).await?;
                    loop {
                        let tag = cr.read_u8().await?;
                        let size = cr.read_u32().await?;
                        let mut body = vec![0; size as usize - 4];
                        cr.read_exact(&mut body).await?;
                        if tag == b'E' || (tag == b'Q' && body != [0]) {
                            executions.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        }
                        if tag == b'P' {
                            prepares.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        }
                        if matches!(tag, b'Q' | b'S' | b'H') {
                            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        }
                        sw.write_u8(tag).await?;
                        sw.write_u32(size).await?;
                        sw.write_all(&body).await?;
                    }
                    #[allow(unreachable_code)]
                    Ok::<(), std::io::Error>(())
                };
                tokio::select! { _ = requests => {}, _ = tokio::io::copy(&mut sr, &mut cw) => {} }
            });
            while clients.try_join_next().is_some() {}
        }
    });
    let app = sqlx::postgres::PgPoolOptions::new()
        .max_connections(3)
        .test_before_acquire(false)
        .connect_with(
            options
                .as_ref()
                .clone()
                .host("127.0.0.1")
                .port(address.port())
                .ssl_mode(sqlx::postgres::PgSslMode::Disable),
        )
        .await
        .unwrap();
    let f = fixture(&app).await;
    let mut socket = f.server.connect(&f.token).await;
    for phase in ["cold", "warm", "warm", "warm"] {
        count.store(0, std::sync::atomic::Ordering::SeqCst);
        prepares.store(0, std::sync::atomic::Ordering::SeqCst);
        executions.store(0, std::sync::atomic::Ordering::SeqCst);
        subscribe(&mut socket, f.channel, 0).await;
        ready(&mut socket, f.channel, 0).await;
        eprintln!(
            "subscription_round_trips phase={phase} total={} prepares={} executions={}",
            count.load(std::sync::atomic::Ordering::SeqCst),
            prepares.load(std::sync::atomic::Ordering::SeqCst),
            executions.load(std::sync::atomic::Ordering::SeqCst)
        );
    }
    drop(socket);
    drop(f);
    app.close().await;
    drop(relays);
}
