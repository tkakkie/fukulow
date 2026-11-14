use super::*;
use uuid::Uuid;

async fn seed(pool: &PgPool, expired: i32) -> Uuid {
    let account = Uuid::new_v4();
    sqlx::query("INSERT INTO accounts (id, email, password_hash) VALUES ($1, $2, 'unused')")
        .bind(account)
        .bind(format!("{account}@example.com"))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO account_sessions (token_hash, account_id, expires_at) \
         SELECT sha256(convert_to($1::text || n::text, 'UTF8')), $1, \
         now() + CASE WHEN n = 0 THEN interval '1 day' ELSE interval '-1 day' END \
         FROM generate_series(0, $2) n",
    )
    .bind(account)
    .bind(expired)
    .execute(pool)
    .await
    .unwrap();
    account
}

async fn expired_sessions(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM account_sessions WHERE expires_at <= now()")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn advance_cleanup_interval() {
    tokio::time::pause();
    tokio::time::advance(INTERVAL + Duration::from_secs(1)).await;
    tokio::time::resume();
}

async fn block_cleanup(pool: &PgPool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    sqlx::raw_sql(
        "CREATE FUNCTION block_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN PERFORM pg_advisory_xact_lock(73); RETURN OLD; END $$; \
         CREATE TRIGGER block_cleanup BEFORE DELETE ON account_sessions \
         FOR EACH ROW EXECUTE FUNCTION block_cleanup();",
    )
    .execute(pool)
    .await
    .unwrap();
    let mut holder = pool.acquire().await.unwrap();
    sqlx::query("SELECT pg_advisory_lock(73)")
        .execute(&mut *holder)
        .await
        .unwrap();
    holder
}

async fn wait_for_blocked_deletes(pool: &PgPool, count: i64) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM pg_stat_activity \
                 WHERE datname = current_database() AND wait_event_type = 'Lock' \
                 AND query LIKE 'DELETE FROM account_sessions%'",
            )
            .fetch_one(pool)
            .await
            .unwrap();
            if waiting >= count {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[fukulow_test::test]
async fn global_cleanup_preserves_valid_sessions_and_bounds_rows_and_frequency(pool: PgPool) {
    let cleanup = SessionCleanup::default();
    let first = seed(&pool, 1_005).await;
    seed(&pool, 1_005).await;
    let valid_before: Vec<(Vec<u8>, String)> = sqlx::query_as(
        "SELECT token_hash, expires_at::text FROM account_sessions WHERE expires_at > now() ORDER BY token_hash",
    ).fetch_all(&pool).await.unwrap();
    let mut held = pool.begin().await.unwrap();
    let locked_hash: Vec<u8> = sqlx::query_scalar(
        "SELECT token_hash FROM account_sessions WHERE account_id = $1 AND expires_at <= now() \
         ORDER BY expires_at, token_hash LIMIT 1 FOR UPDATE",
    )
    .bind(first)
    .fetch_one(&mut *held)
    .await
    .unwrap();
    for _ in 0..5 {
        cleanup.trigger(&pool);
    }
    cleanup.finished().await;
    assert_eq!(cleanup.started(), 1);
    assert_eq!(expired_sessions(&pool).await, 1_010);
    assert!(
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM account_sessions WHERE token_hash = $1)"
        )
        .bind(locked_hash)
        .fetch_one(&pool)
        .await
        .unwrap()
    );
    held.rollback().await.unwrap();
    cleanup.trigger(&pool);
    assert_eq!(cleanup.started(), 1);
    advance_cleanup_interval().await;
    cleanup.trigger(&pool);
    cleanup.finished().await;
    assert_eq!(expired_sessions(&pool).await, 10);
    advance_cleanup_interval().await;
    cleanup.trigger(&pool);
    cleanup.finished().await;
    assert_eq!(expired_sessions(&pool).await, 0);
    let valid_after: Vec<(Vec<u8>, String)> = sqlx::query_as(
        "SELECT token_hash, expires_at::text FROM account_sessions WHERE expires_at > now() ORDER BY token_hash",
    ).fetch_all(&pool).await.unwrap();
    assert_eq!(valid_before, valid_after);
}

#[fukulow_test::test]
async fn sign_in_does_not_wait_for_a_blocked_cleanup(pool: PgPool) {
    let cleanup = SessionCleanup::default();
    seed(&pool, 1).await;
    let mut holder = block_cleanup(&pool).await;
    cleanup.trigger(&pool);
    wait_for_blocked_deletes(&pool, 1).await;
    assert!(cleanup.running());
    assert_eq!(expired_sessions(&pool).await, 1);
    sqlx::query("SELECT pg_advisory_unlock(73)")
        .execute(&mut *holder)
        .await
        .unwrap();
    cleanup.finished().await;
    assert!(!cleanup.running());
}

#[fukulow_test::test]
async fn concurrent_sign_ins_start_at_most_one_cleanup_run(pool: PgPool) {
    let cleanup = SessionCleanup::default();
    seed(&pool, 1).await;
    let tasks: Vec<_> = (0..128)
        .map(|_| {
            let cleanup = cleanup.clone();
            let pool = pool.clone();
            tokio::spawn(async move {
                cleanup.trigger(&pool);
            })
        })
        .collect();
    for task in tasks {
        task.await.unwrap();
    }
    cleanup.finished().await;
    assert_eq!(cleanup.started(), 1);
}

#[fukulow_test::test]
async fn a_running_cleanup_blocks_new_runs_until_completion_or_cancellation(pool: PgPool) {
    let cleanup = SessionCleanup::with_interval(Duration::ZERO);
    seed(&pool, 1_005).await;
    let mut holder = block_cleanup(&pool).await;
    cleanup.trigger(&pool);
    wait_for_blocked_deletes(&pool, 1).await;
    cleanup.trigger(&pool);
    assert_eq!(cleanup.started(), 1);
    cleanup.abort();
    cleanup.finished().await;
    assert!(!cleanup.running());
    cleanup.trigger(&pool);
    assert_eq!(cleanup.started(), 2);
    wait_for_blocked_deletes(&pool, 2).await;
    cleanup.trigger(&pool);
    assert_eq!(cleanup.started(), 2);
    sqlx::query("SELECT pg_advisory_unlock(73)")
        .execute(&mut *holder)
        .await
        .unwrap();
    cleanup.finished().await;
    cleanup.trigger(&pool);
    cleanup.finished().await;
    assert_eq!(cleanup.started(), 3);
}

#[fukulow_test::test]
async fn cancelled_cleanup_releases_the_guard_but_consumes_the_interval(pool: PgPool) {
    let cleanup = SessionCleanup::default();
    seed(&pool, 1).await;
    cleanup.trigger(&pool);
    cleanup.abort();
    cleanup.finished().await;
    assert!(!cleanup.running());
    cleanup.trigger(&pool);
    assert_eq!(cleanup.started(), 1);
    advance_cleanup_interval().await;
    cleanup.trigger(&pool);
    cleanup.finished().await;
    assert_eq!(cleanup.started(), 2);
}

#[fukulow_test::test]
async fn cleanup_timeout_does_not_block_caller_and_consumes_the_interval(pool: PgPool) {
    let cleanup = SessionCleanup::default();
    seed(&pool, 1).await;
    let isolated = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(DEADLINE + Duration::from_secs(10))
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let held = isolated.acquire().await.unwrap();
    let started = Instant::now();
    cleanup.trigger(&isolated);
    tokio::time::timeout(DEADLINE + Duration::from_secs(3), cleanup.finished())
        .await
        .unwrap();
    assert!(started.elapsed() >= DEADLINE);
    assert!(!cleanup.running());
    assert_eq!(expired_sessions(&pool).await, 1);
    cleanup.trigger(&pool);
    assert_eq!(cleanup.started(), 1);
    drop(held);
    isolated.close().await;
}

#[fukulow_test::test]
async fn cleanup_failure_is_frequency_limited(pool: PgPool) {
    let cleanup = SessionCleanup::default();
    seed(&pool, 1).await;
    sqlx::raw_sql(
        "CREATE FUNCTION reject_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN RAISE EXCEPTION 'test cleanup failure'; END $$; \
         CREATE TRIGGER reject_cleanup BEFORE DELETE ON account_sessions \
         FOR EACH ROW EXECUTE FUNCTION reject_cleanup();",
    )
    .execute(&pool)
    .await
    .unwrap();
    cleanup.trigger(&pool);
    cleanup.finished().await;
    assert_eq!(expired_sessions(&pool).await, 1);
    cleanup.trigger(&pool);
    assert_eq!(cleanup.started(), 1);
    sqlx::query("DROP TRIGGER reject_cleanup ON account_sessions")
        .execute(&pool)
        .await
        .unwrap();
    advance_cleanup_interval().await;
    cleanup.trigger(&pool);
    cleanup.finished().await;
    assert_eq!(expired_sessions(&pool).await, 0);
}

#[fukulow_test::test]
async fn successful_sign_in_triggers_cleanup_without_waiting_or_failing_on_cleanup_error(
    pool: PgPool,
) {
    use axum::{
        body::Body,
        extract::ConnectInfo,
        http::{Request, StatusCode, header},
    };
    use tower::ServiceExt;
    let cleanup = SessionCleanup::default();
    let state = crate::AppState {
        session_cleanup: cleanup.clone(),
        ..crate::AppState::for_test(pool.clone()).await
    };
    let app = crate::app(state);
    let setup = serde_json::json!({"setup_token": "setup-token-test-only",
                    "organization_name":"Organization", "name":"Owner", "email":"owner@example.com", "password":"correct horse battery staple"});
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/v1/setup")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(setup.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    seed(&pool, 1).await;
    let mut holder = block_cleanup(&pool).await;
    let sign_in = || {
        Request::post("/api/v1/session")
        .extension(ConnectInfo("192.0.2.1:1234".parse::<std::net::SocketAddr>().unwrap()))
        .header(header::CONTENT_TYPE,"application/json")
        .body(Body::from(serde_json::json!({"email":"owner@example.com", "password":"correct horse battery staple"}).to_string())).unwrap()
    };
    let response = app.clone().oneshot(sign_in()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    wait_for_blocked_deletes(&pool, 1).await;
    assert!(
        cleanup.running(),
        "Sign in must return while cleanup still waits for SQL"
    );
    assert!(response.headers().contains_key(header::SET_COOKIE));
    sqlx::query("SELECT pg_advisory_unlock(73)")
        .execute(&mut *holder)
        .await
        .unwrap();
    cleanup.finished().await;
    seed(&pool, 1).await;
    sqlx::query("DROP TRIGGER block_cleanup ON account_sessions")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE FUNCTION reject_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test cleanup failure'; END $$; CREATE TRIGGER reject_cleanup BEFORE DELETE ON account_sessions FOR EACH ROW EXECUTE FUNCTION reject_cleanup();").execute(&pool).await.unwrap();
    advance_cleanup_interval().await;
    assert_eq!(
        app.clone().oneshot(sign_in()).await.unwrap().status(),
        StatusCode::OK
    );
    cleanup.finished().await;
    assert_eq!(expired_sessions(&pool).await, 1);
    assert_eq!(cleanup.started(), 2);
    assert_eq!(
        app.oneshot(sign_in()).await.unwrap().status(),
        StatusCode::OK
    );
    cleanup.finished().await;
    assert_eq!(cleanup.started(), 2);
}
