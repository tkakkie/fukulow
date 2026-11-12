use sqlx::{
    PgPool,
    postgres::{PgPoolOptions, PgSslMode},
};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Notify, watch},
    task::JoinSet,
};

pub(super) struct Relay {
    pub pool: PgPool,
    pub hold: watch::Sender<bool>,
    pub blocked: Arc<Notify>,
    pub stall_return: Arc<AtomicBool>,
    pub returns: Arc<AtomicUsize>,
    _tasks: JoinSet<()>,
}

impl Relay {
    pub async fn new(pool: &PgPool, max: u32) -> Self {
        let options = pool.connect_options();
        let upstream = (options.get_host().to_owned(), options.get_port());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (hold, gate) = watch::channel(false);
        let blocked = Arc::new(Notify::new());
        let observed = blocked.clone();
        let mut tasks = JoinSet::new();
        tasks.spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                let (mut client, _) = listener.accept().await.unwrap();
                let mut server = TcpStream::connect((upstream.0.as_str(), upstream.1))
                    .await
                    .unwrap();
                let mut gate = gate.clone();
                let observed = observed.clone();
                connections.spawn(async move {
                    let (mut client_read, mut client_write) = client.split();
                    let (mut server_read, mut server_write) = server.split();
                    let requests = tokio::io::copy(&mut client_read, &mut server_write);
                    let responses = async {
                        let mut bytes = [0; 8192];
                        loop {
                            let count = server_read.read(&mut bytes).await?;
                            if count == 0 {
                                return Ok::<_, std::io::Error>(());
                            }
                            while *gate.borrow_and_update() {
                                observed.notify_one();
                                if gate.changed().await.is_err() {
                                    return Ok(());
                                }
                            }
                            client_write.write_all(&bytes[..count]).await?;
                        }
                    };
                    tokio::select! { _ = requests => {}, _ = responses => {} }
                });
                while connections.try_join_next().is_some() {}
            }
        });
        let stall_return = Arc::new(AtomicBool::new(false));
        let returns = Arc::new(AtomicUsize::new(0));
        let single = PgPoolOptions::new()
            .max_connections(max)
            .test_before_acquire(false)
            .after_release({
                let hold = hold.clone();
                let stall = stall_return.clone();
                let returns = returns.clone();
                move |_, _| {
                    returns.fetch_add(1, Ordering::SeqCst);
                    // Run SELECT 1 normally, then stall the actual SQLx return ping.
                    if stall.swap(false, Ordering::SeqCst) {
                        hold.send_replace(true);
                    }
                    Box::pin(async { Ok(true) })
                }
            })
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
        Self {
            pool: single,
            hold,
            blocked,
            stall_return,
            returns,
            _tasks: tasks,
        }
    }
}
