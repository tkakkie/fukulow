use crate::database::read_only;
use sqlx::{PgPool, postgres::PgSslMode};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{oneshot, watch},
    task::JoinSet,
};

#[sqlx::test(migrations = false)]
async fn cancelled_read_only_begin_discards_connection_before_next_write(pool: PgPool) {
    tokio::time::timeout(Duration::from_secs(15), async {
        let options = pool.connect_options();
        let upstream = (options.get_host().to_owned(), options.get_port());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (hold, gate) = watch::channel(false);
        let mut relays = JoinSet::new();
        relays.spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                let (mut client, _) = listener.accept().await.unwrap();
                let mut server = TcpStream::connect((upstream.0.as_str(), upstream.1))
                    .await
                    .unwrap();
                let mut gate = gate.clone();
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
                                if gate.changed().await.is_err() {
                                    return Ok(());
                                }
                            }
                            client_write.write_all(&bytes[..count]).await?;
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
        let mut connection = single.acquire().await.unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
        // Finish the release-time ping before withholding responses to BEGIN.
        connection.return_to_pool().await;
        drop(connection);
        hold.send(true).unwrap();
        let mut begin = Box::pin(read_only(&single, async |_tx: &mut sqlx::PgConnection| {
            Ok::<_, sqlx::Error>(())
        }));
        let executed = async {
            loop {
                let executed: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT FROM pg_stat_activity WHERE pid = $1 \
                     AND state = 'idle in transaction' \
                     AND query = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')",
                )
                .bind(pid)
                .fetch_one(&pool)
                .await
                .unwrap();
                if executed {
                    break;
                }
            }
        };
        tokio::select! {
            result = &mut begin => panic!("BEGIN response escaped the relay gate: {result:?}"),
            () = executed => {}
        }
        // PostgreSQL executed BEGIN, but no response byte can reach SQLx until after Drop.
        drop(begin);
        hold.send(false).unwrap();
        let mut write = single.begin().await.unwrap();
        sqlx::query("CREATE TABLE read_only_begin_probe (organization_id uuid NOT NULL)")
            .execute(&mut *write)
            .await
            .expect("write after cancelled read-only BEGIN must succeed");
        let read_only: String = sqlx::query_scalar("SHOW transaction_read_only")
            .fetch_one(&mut *write)
            .await
            .unwrap();
        assert_eq!(read_only, "off");
        write.commit().await.unwrap();
        single.close().await;
        // Dropping both JoinSets closes the listener and any remaining forwarded sockets.
        drop(relays);
    })
    .await
    .expect("cancelled BEGIN recovery must not hang");
}

#[sqlx::test(migrations = false)]
async fn read_only_begin_preserves_snapshot_settings(pool: PgPool) {
    read_only(&pool, async |tx: &mut sqlx::PgConnection| {
        let read_only: String = sqlx::query_scalar("SHOW transaction_read_only")
            .fetch_one(&mut *tx)
            .await?;
        let isolation: String = sqlx::query_scalar("SHOW transaction_isolation")
            .fetch_one(&mut *tx)
            .await?;
        assert_eq!(read_only, "on");
        assert_eq!(isolation, "repeatable read");
        Ok::<_, sqlx::Error>(())
    })
    .await
    .unwrap();
}

async fn single_connection_pool(pool: &PgPool) -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .test_before_acquire(false)
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap()
}

async fn assert_clean_reuse(pool: &PgPool, single: &PgPool, expected_pid: i32) {
    let mut connection = single.acquire().await.unwrap();
    let (pid, read_only): (i32, String) =
        sqlx::query_as("SELECT pg_backend_pid(), current_setting('transaction_read_only')")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
    assert_eq!(
        pid, expected_pid,
        "completed reads must reuse their backend"
    );
    assert_eq!(read_only, "off");
    // Observe from a different connection while holding the reused one out of the pool.
    let idle: bool = sqlx::query_scalar(
        "SELECT state = 'idle' AND xact_start IS NULL FROM pg_stat_activity WHERE pid = $1",
    )
    .bind(pid)
    .fetch_one(pool)
    .await
    .unwrap();
    assert!(idle, "the reused backend must have no open transaction");
}

#[sqlx::test(migrations = false)]
async fn successful_read_only_reuses_clean_connection(pool: PgPool) {
    let single = single_connection_pool(&pool).await;
    let pid: i32 = read_only(&single, async |tx: &mut sqlx::PgConnection| {
        sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *tx)
            .await
    })
    .await
    .unwrap();
    assert_clean_reuse(&pool, &single, pid).await;
    single.close().await;
}

#[sqlx::test(migrations = false)]
async fn read_only_body_error_reuses_clean_connection(pool: PgPool) {
    let single = single_connection_pool(&pool).await;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&single)
        .await
        .unwrap();
    let result = read_only(&single, async |tx: &mut sqlx::PgConnection| {
        let current_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *tx)
            .await?;
        assert_eq!(current_pid, pid);
        Err::<(), _>(sqlx::Error::RowNotFound)
    })
    .await;
    assert!(matches!(result, Err(sqlx::Error::RowNotFound)));
    assert_clean_reuse(&pool, &single, pid).await;
    single.close().await;
}

#[sqlx::test(migrations = false)]
async fn cancelled_read_only_body_discards_connection_before_next_write(pool: PgPool) {
    tokio::time::timeout(Duration::from_secs(15), async {
        let single = single_connection_pool(&pool).await;
        let (started, running) = oneshot::channel();
        let mut read = Box::pin(read_only(&single, async |tx: &mut sqlx::PgConnection| {
            let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
                .fetch_one(&mut *tx)
                .await?;
            started.send(pid).unwrap();
            std::future::pending::<Result<(), sqlx::Error>>().await
        }));
        let cancelled_pid = tokio::select! {
            result = &mut read => panic!("body must wait for cancellation: {result:?}"),
            pid = running => pid.unwrap(),
        };
        drop(read);
        let mut write = single.begin().await.unwrap();
        sqlx::query("CREATE TABLE read_only_body_probe (organization_id uuid NOT NULL)")
            .execute(&mut *write)
            .await
            .expect("write after cancelled read-only body must succeed");
        let (pid, read_only): (i32, String) =
            sqlx::query_as("SELECT pg_backend_pid(), current_setting('transaction_read_only')")
                .fetch_one(&mut *write)
                .await
                .unwrap();
        assert_ne!(pid, cancelled_pid, "cancellation must discard the backend");
        assert_eq!(read_only, "off");
        write.commit().await.unwrap();
        single.close().await;
    })
    .await
    .expect("cancelled body recovery must not hang");
}
