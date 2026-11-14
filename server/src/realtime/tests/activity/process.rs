use super::*;
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
};
use tokio::io::AsyncWriteExt;

struct Process {
    child: Child,
    ready: PathBuf,
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.ready);
    }
}
async fn start(database: &str, address: std::net::SocketAddr) -> Process {
    let ready = std::env::temp_dir().join(format!("activity-ready-{}", Uuid::new_v4()));
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "realtime::tests::activity::process::activity_process_child",
        ])
        .env("ACTIVITY_CHILD_DB", database)
        .env("ACTIVITY_CHILD_ADDRESS", address.to_string())
        .env("ACTIVITY_CHILD_READY", &ready)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut process = Process { child, ready };
    tokio::time::timeout(Duration::from_secs(10), async {
        while !process.ready.exists() {
            assert!(
                process.child.try_wait().unwrap().is_none(),
                "activity child exited before readiness"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    process
}
#[fukulow_test::test]
#[ignore = "subprocess helper for an actual process restart with a surviving PostgreSQL COMMIT"]
async fn activity_process_child() {
    use std::str::FromStr;
    let database = std::env::var("ACTIVITY_CHILD_DB").unwrap();
    let options =
        sqlx::postgres::PgConnectOptions::from_str(&std::env::var("DATABASE_URL").unwrap())
            .unwrap()
            .database(&database);
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .unwrap();
    let app = crate::app(state(&pool).await);
    let listener = TcpListener::bind(std::env::var("ACTIVITY_CHILD_ADDRESS").unwrap())
        .await
        .unwrap();
    std::fs::write(std::env::var("ACTIVITY_CHILD_READY").unwrap(), b"ready").unwrap();
    axum::serve(listener, app).await.unwrap();
}
async fn list_count(address: std::net::SocketAddr, token: &str, channel: Uuid) -> i64 {
    let (status, body) = super::super::contract::http::request(
        address,
        "GET",
        "/api/v1/channels",
        token,
        Value::Null,
    )
    .await;
    assert_eq!(status, 200);
    body["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == channel.to_string())
        .unwrap()["unread_count"]
        .as_i64()
        .unwrap()
}
#[fukulow_test::test]
async fn process_restart_keeps_reconciling_a_commit_that_survives_the_old_process(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_, reader_token) = member(&pool, f.organization).await;
    let database: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let reserved = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = reserved.local_addr().unwrap();
    drop(reserved);
    let lock = f.channel.as_u128() as i64;
    let mut blocker = pool.acquire().await.unwrap();
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(lock)
        .execute(&mut *blocker)
        .await
        .unwrap();
    sqlx::raw_sql(&format!("CREATE FUNCTION delay_activity_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.body='surviving commit' THEN PERFORM pg_advisory_xact_lock({lock}); END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER delay_activity_commit AFTER INSERT ON messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION delay_activity_commit()"))
        .execute(&pool).await.unwrap();
    let mut old = start(&database, address).await;
    let mut old_socket = connect_at(address, &reader_token).await;
    assert_eq!(raw_event(&mut old_socket).await["type"], "activity_ready");
    let mut pending = TcpStream::connect(address).await.unwrap();
    let body = json!({"client_message_id":Uuid::new_v4(),"body":"surviving commit"}).to_string();
    let bytes = format!(
        "POST /api/v1/orgs/{}/channels/{}/messages HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        f.organization,
        f.channel,
        f.token,
        body.len()
    );
    pending.write_all(bytes.as_bytes()).await.unwrap();
    let backend = tokio::time::timeout(Duration::from_secs(5), async { loop {
        let pid: Option<i32> = sqlx::query_scalar("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND query='COMMIT' AND wait_event='advisory'").fetch_optional(&pool).await.unwrap();
        if let Some(pid) = pid { return pid; } tokio::time::sleep(Duration::from_millis(10)).await;
    }}).await.unwrap();
    assert_eq!(list_count(address, &reader_token, f.channel).await, 0);
    old.child.kill().unwrap();
    old.child.wait().unwrap();
    drop(old);
    drop(old_socket);
    drop(pending);
    assert!(
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1)"
        )
        .bind(backend)
        .fetch_one(&pool)
        .await
        .unwrap()
    );
    let _new = start(&database, address).await;
    let mut socket = connect_at(address, &reader_token).await;
    assert_eq!(raw_event(&mut socket).await["type"], "activity_ready");
    // The new registration's successful old snapshot cannot discharge O5 recovery.
    assert_eq!(list_count(address, &reader_token, f.channel).await, 0);
    sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(lock)
        .execute(&mut *blocker)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if list_count(address, &reader_token, f.channel).await == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    // No mutation or notice from either process followed the delayed COMMIT.
    assert!(
        collect(
            &f.state.message_delivery.channel_access.activity,
            &mut socket
        )
        .await
        .is_empty()
    );
}
