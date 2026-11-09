use super::*;
use crate::AppState;
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::ConnectInfo,
    http::{Request, StatusCode, header},
    response::Response,
};
use serde_json::{Value, json};
use tower::ServiceExt;

const PASSWORD: &str = "correct horse battery staple";

fn router(pool: &PgPool, cleanup: &SessionCleanup) -> Router {
    crate::app(AppState {
        session_cleanup: cleanup.clone(),
        ..AppState::for_test(pool.clone())
    })
}

async fn request(app: &Router, method: &str, path: &str, body: Value, bearer: &str) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .extension(ConnectInfo(
            "192.0.2.1:1234".parse::<std::net::SocketAddr>().unwrap(),
        ));
    if !bearer.is_empty() {
        request = request.header(header::AUTHORIZATION, format!("Bearer {bearer}"));
    }
    app.clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
}

async fn sign_in(app: &Router, organization: Uuid) -> Response {
    request(
        app,
        "POST",
        "/api/v1/session",
        json!({"organization_id": organization, "email": "owner@example.com", "password": PASSWORD}),
        "",
    )
    .await
}

/// Sets up the first Organization through the API, then adds `others` with the same
/// Member id, email and password hash so missing Organization scopes collide.
async fn organizations(pool: &PgPool, app: &Router, others: &[Uuid]) -> Uuid {
    let response = request(
        app,
        "POST",
        "/api/v1/setup",
        json!({"organization_name": "Organization A", "name": "Owner A", "email": "owner@example.com", "password": PASSWORD}),
        "",
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32 * 1024).await.unwrap()).unwrap();
    let first: Uuid = body["organization"]["organization_id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    for &other in others {
        insert_organization(pool, other).await;
        sqlx::query(
            "INSERT INTO users (organization_id, id, email, name, password_hash, role) \
             SELECT $1, id, email, 'Owner', password_hash, 'guest' FROM users WHERE organization_id = $2",
        )
        .bind(other)
        .bind(first)
        .execute(pool)
        .await
        .unwrap();
    }
    first
}

async fn insert_organization(pool: &PgPool, organization: Uuid) {
    sqlx::query("INSERT INTO organizations (organization_id, name) VALUES ($1, 'Organization')")
        .bind(organization)
        .execute(pool)
        .await
        .unwrap();
}

/// One valid session plus `expired` expired ones per Member, with equal hashes across tenants.
async fn seed_cleanup_sessions(pool: &PgPool, organization: Uuid, expired: i32) {
    sqlx::query(
        "INSERT INTO sessions (organization_id, token_hash, user_id, expires_at) \
         SELECT organization_id, sha256(convert_to(n::text, 'UTF8')), id, \
         now() + CASE WHEN n = 0 THEN interval '1 day' ELSE interval '-1 day' END \
         FROM users CROSS JOIN generate_series(0, $2) n WHERE organization_id = $1",
    )
    .bind(organization)
    .bind(expired)
    .execute(pool)
    .await
    .unwrap();
}

async fn expired_sessions(pool: &PgPool, organization: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM sessions WHERE organization_id = $1 AND expires_at <= now()",
    )
    .bind(organization)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn advance_cleanup_interval_and_expire_throttle_window() {
    // Pause only between SQL operations (no cleanup task running); network I/O needs a running clock.
    tokio::time::pause();
    tokio::time::advance(INTERVAL + Duration::from_secs(1)).await;
    tokio::time::resume();
}

/// Every cleanup DELETE waits for advisory lock 73 while the returned connection holds it.
async fn block_cleanup(pool: &PgPool) -> sqlx::pool::PoolConnection<sqlx::Postgres> {
    sqlx::raw_sql(
        "CREATE FUNCTION block_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN PERFORM pg_advisory_xact_lock(73); RETURN OLD; END $$; \
         CREATE TRIGGER block_cleanup BEFORE DELETE ON sessions \
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

/// Waits until `count` cleanup DELETEs in this test database wait on a lock (an aborted
/// run's backend keeps waiting until the lock is released, so it still counts).
async fn wait_for_blocked_deletes(pool: &PgPool, count: i64) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM pg_stat_activity \
                 WHERE datname = current_database() AND wait_event_type = 'Lock' \
                 AND query LIKE 'DELETE FROM sessions%'",
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
    .expect("the cleanup DELETE must be blocked");
}

#[sqlx::test]
async fn sign_in_cleanup_is_scoped_preserves_valid_sessions_and_bounds_rows_and_frequency(
    pool: PgPool,
) {
    let cleanup = SessionCleanup::default();
    let app = router(&pool, &cleanup);
    // The largest id fixes the round-robin order: first, then second.
    let second = Uuid::max();
    let first = organizations(&pool, &app, &[second]).await;
    for organization in [first, second] {
        // Equal token hashes across tenants catch a missing outer DELETE scope.
        seed_cleanup_sessions(&pool, organization, 1_005).await;
    }
    let valid_before: Vec<(Uuid, Vec<u8>, String)> = sqlx::query_as(
        "SELECT organization_id, token_hash, expires_at::text FROM sessions \
         WHERE expires_at > now() ORDER BY organization_id, token_hash",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    let mut locked = pool.begin().await.unwrap();
    let locked_hash: Vec<u8> = sqlx::query_scalar(
        "SELECT token_hash FROM sessions WHERE organization_id = $1 AND expires_at <= now() \
         ORDER BY expires_at, token_hash LIMIT 1 FOR UPDATE",
    )
    .bind(first)
    .fetch_one(&mut *locked)
    .await
    .unwrap();
    // Race the first successful sign-ins while an expired row is locked elsewhere.
    let (a, b, c) = tokio::join!(
        sign_in(&app, first),
        sign_in(&app, first),
        sign_in(&app, first),
    );
    for response in [a, b, c] {
        assert_eq!(response.status(), StatusCode::OK);
    }
    cleanup.finished().await;
    assert_eq!(cleanup.started(), 1);
    assert_eq!(expired_sessions(&pool, first).await, 5);
    assert_eq!(expired_sessions(&pool, second).await, 1_005);
    assert!(
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM sessions WHERE organization_id = $1 AND token_hash = $2)",
        )
        .bind(first)
        .bind(locked_hash)
        .fetch_one(&pool)
        .await
        .unwrap()
    );
    locked.rollback().await.unwrap();

    // Concurrent successful sign-ins in either tenant share the process gate.
    let (a, b, c) = tokio::join!(
        sign_in(&app, first),
        sign_in(&app, first),
        sign_in(&app, second),
    );
    for response in [a, b, c] {
        assert_eq!(response.status(), StatusCode::OK);
    }
    cleanup.finished().await;
    assert_eq!(cleanup.started(), 1);
    assert_eq!(expired_sessions(&pool, first).await, 5);
    assert_eq!(expired_sessions(&pool, second).await, 1_005);

    // A sign-in to the first Organization serves the next Organization in id order.
    advance_cleanup_interval_and_expire_throttle_window().await;
    assert_eq!(sign_in(&app, first).await.status(), StatusCode::OK);
    cleanup.finished().await;
    assert_eq!(expired_sessions(&pool, second).await, 5);
    assert_eq!(expired_sessions(&pool, first).await, 5);
    // The cursor wraps to the smallest id.
    advance_cleanup_interval_and_expire_throttle_window().await;
    assert_eq!(sign_in(&app, first).await.status(), StatusCode::OK);
    cleanup.finished().await;
    assert_eq!(expired_sessions(&pool, first).await, 0);
    assert_eq!(expired_sessions(&pool, second).await, 5);
    assert_eq!(cleanup.started(), 3);
    for (organization, hash, expiry) in valid_before {
        let retained: String = sqlx::query_scalar(
            "SELECT expires_at::text FROM sessions WHERE organization_id = $1 AND token_hash = $2",
        )
        .bind(organization)
        .bind(hash)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(retained, expiry);
    }
}

#[sqlx::test]
async fn every_organization_gets_a_batch_within_t_permitted_attempts(pool: PgPool) {
    // T = 3: A signs in on every attempt; B and C never sign in but hold expired rows.
    let cleanup = SessionCleanup::with_interval(Duration::ZERO);
    let app = router(&pool, &cleanup);
    let (b, c) = (Uuid::new_v4(), Uuid::new_v4());
    let a = organizations(&pool, &app, &[b, c]).await;
    seed_cleanup_sessions(&pool, a, 3).await;
    for organization in [b, c] {
        seed_cleanup_sessions(&pool, organization, 1_005).await;
    }
    let mut before = [3, 1_005, 1_005];
    for _ in 0..3 {
        assert_eq!(sign_in(&app, a).await.status(), StatusCode::OK);
        cleanup.finished().await;
        let mut after = [0; 3];
        for (count, organization) in after.iter_mut().zip([a, b, c]) {
            *count = expired_sessions(&pool, organization).await;
        }
        // Each run deletes rows of exactly one Organization.
        let changed = before.iter().zip(&after).filter(|(x, y)| x != y).count();
        assert_eq!(changed, 1, "{before:?} -> {after:?}");
        before = after;
    }
    // Lock skipping, SQL errors and timeouts also consume a turn; a failed
    // selection query does not (see selection_failure_consumes_the_interval_and_keeps_the_cursor).
    assert_eq!(before, [0, 5, 5]);
}

#[sqlx::test]
async fn sign_in_does_not_wait_for_a_blocked_cleanup(pool: PgPool) {
    let cleanup = SessionCleanup::default();
    let app = router(&pool, &cleanup);
    let organization = organizations(&pool, &app, &[]).await;
    seed_cleanup_sessions(&pool, organization, 1).await;
    let mut holder = block_cleanup(&pool).await;
    let response = sign_in(&app, organization).await;
    assert_eq!(response.status(), StatusCode::OK);
    // An awaited cleanup could only have returned after its 1-second statement timeout.
    assert!(cleanup.running());
    assert_eq!(expired_sessions(&pool, organization).await, 1);
    sqlx::query("SELECT pg_advisory_unlock(73)")
        .execute(&mut *holder)
        .await
        .unwrap();
    cleanup.finished().await;
    assert!(!cleanup.running());
}

#[sqlx::test]
async fn concurrent_sign_ins_start_at_most_one_cleanup_run(pool: PgPool) {
    let cleanup = SessionCleanup::default();
    let app = router(&pool, &cleanup);
    let organization = organizations(&pool, &app, &[]).await;
    let responses = tokio::join!(
        sign_in(&app, organization),
        sign_in(&app, organization),
        sign_in(&app, organization),
        sign_in(&app, organization),
        sign_in(&app, organization),
    );
    let (a, b, c, d, e) = responses;
    for response in [a, b, c, d, e] {
        assert_eq!(response.status(), StatusCode::OK);
    }
    cleanup.finished().await;
    assert_eq!(cleanup.started(), 1);
}

#[sqlx::test]
async fn a_running_cleanup_blocks_new_runs_until_completion_or_cancellation(pool: PgPool) {
    // No interval, so only the single-flight guard can refuse a start.
    let cleanup = SessionCleanup::with_interval(Duration::ZERO);
    let app = router(&pool, &cleanup);
    let organization = organizations(&pool, &app, &[]).await;
    // More than one batch, so the second run still finds rows the aborted run did not lock.
    seed_cleanup_sessions(&pool, organization, 1_005).await;
    let mut holder = block_cleanup(&pool).await;
    cleanup.trigger(&pool);
    assert_eq!(cleanup.started(), 1);
    // Refuse the duplicate only once the task is really executing its DELETE.
    wait_for_blocked_deletes(&pool, 1).await;
    assert!(cleanup.running());
    cleanup.trigger(&pool);
    assert_eq!(cleanup.started(), 1);
    // Cancellation releases the guard.
    cleanup.abort();
    cleanup.finished().await;
    assert!(!cleanup.running());
    cleanup.trigger(&pool);
    assert_eq!(cleanup.started(), 2);
    // The aborted run's backend still waits too, so wait for two.
    wait_for_blocked_deletes(&pool, 2).await;
    assert!(cleanup.running());
    cleanup.trigger(&pool);
    assert_eq!(cleanup.started(), 2);
    sqlx::query("SELECT pg_advisory_unlock(73)")
        .execute(&mut *holder)
        .await
        .unwrap();
    // Completion releases the guard.
    cleanup.finished().await;
    assert!(!cleanup.running());
    cleanup.trigger(&pool);
    assert_eq!(cleanup.started(), 3);
    cleanup.finished().await;
}

#[sqlx::test]
async fn cancelled_cleanup_releases_the_guard_but_consumes_the_interval(pool: PgPool) {
    // The normal 60-second interval, not a test override.
    let cleanup = SessionCleanup::default();
    let app = router(&pool, &cleanup);
    let organization = organizations(&pool, &app, &[]).await;
    seed_cleanup_sessions(&pool, organization, 1).await;
    let mut holder = block_cleanup(&pool).await;
    cleanup.trigger(&pool);
    assert_eq!(cleanup.started(), 1);
    cleanup.abort();
    cleanup.finished().await;
    assert!(!cleanup.running());
    // Within the interval a restart is refused even though no run is in progress.
    cleanup.trigger(&pool);
    assert_eq!(cleanup.started(), 1);
    assert!(!cleanup.running());
    sqlx::query("SELECT pg_advisory_unlock(73)")
        .execute(&mut *holder)
        .await
        .unwrap();
    advance_cleanup_interval_and_expire_throttle_window().await;
    cleanup.trigger(&pool);
    assert_eq!(cleanup.started(), 2);
    cleanup.finished().await;
}

#[sqlx::test]
async fn cancellation_during_delete_keeps_the_advanced_cursor(pool: PgPool) {
    let cleanup = SessionCleanup::default();
    let app = router(&pool, &cleanup);
    let first = Uuid::from_u128(1);
    let second = Uuid::from_u128(2);
    // The API-created Organization sorts after both fixed ids.
    organizations(&pool, &app, &[first, second]).await;
    for organization in [first, second] {
        seed_cleanup_sessions(&pool, organization, 1_005).await;
    }
    let mut holder = block_cleanup(&pool).await;
    cleanup.trigger(&pool);
    // Wait until the first Organization is selected and its DELETE waits on the lock.
    wait_for_blocked_deletes(&pool, 1).await;
    assert_eq!(cleanup.cursor(), Some(first));
    cleanup.abort();
    cleanup.finished().await;
    assert!(!cleanup.running());
    // Cancellation does not roll the cursor back.
    assert_eq!(cleanup.cursor(), Some(first));
    sqlx::query("SELECT pg_advisory_unlock(73)")
        .execute(&mut *holder)
        .await
        .unwrap();
    sqlx::query("DROP TRIGGER block_cleanup ON sessions")
        .execute(&pool)
        .await
        .unwrap();
    // The next permitted run serves the second Organization.
    advance_cleanup_interval_and_expire_throttle_window().await;
    cleanup.trigger(&pool);
    cleanup.finished().await;
    assert_eq!(cleanup.cursor(), Some(second));
    assert_eq!(expired_sessions(&pool, second).await, 5);
}

#[sqlx::test]
async fn selection_failure_consumes_the_interval_and_keeps_the_cursor(pool: PgPool) {
    let cleanup = SessionCleanup::default();
    let app = router(&pool, &cleanup);
    let first = Uuid::from_u128(1);
    let second = Uuid::from_u128(2);
    // The API-created Organization sorts after both fixed ids.
    let third = organizations(&pool, &app, &[first, second]).await;
    for organization in [first, second] {
        seed_cleanup_sessions(&pool, organization, 1_005).await;
    }
    cleanup.trigger(&pool);
    cleanup.finished().await;
    assert_eq!(expired_sessions(&pool, first).await, 5);
    assert_eq!(expired_sessions(&pool, second).await, 1_005);

    advance_cleanup_interval_and_expire_throttle_window().await;
    // The selection query hits the 1-second statement timeout.
    let mut locked = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE organizations IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *locked)
        .await
        .unwrap();
    cleanup.trigger(&pool);
    cleanup.finished().await;
    locked.rollback().await.unwrap();
    assert_eq!(cleanup.started(), 2);
    assert_eq!(expired_sessions(&pool, second).await, 1_005);
    // The failed run consumed the interval.
    cleanup.trigger(&pool);
    assert_eq!(cleanup.started(), 2);

    // The cursor stayed on the first Organization, so the second one is next.
    // This is the exception to the T-attempt guarantee: the failed attempt served nobody.
    advance_cleanup_interval_and_expire_throttle_window().await;
    cleanup.trigger(&pool);
    cleanup.finished().await;
    assert_eq!(expired_sessions(&pool, second).await, 5);
    assert_eq!(expired_sessions(&pool, first).await, 5);
    assert!(third > second);
}

#[sqlx::test]
async fn failed_delete_still_moves_the_turn_to_the_next_organization(pool: PgPool) {
    // The normal 60-second interval, not a test override.
    let cleanup = SessionCleanup::default();
    let app = router(&pool, &cleanup);
    let first = Uuid::from_u128(1);
    let second = Uuid::from_u128(2);
    // The API-created Organization sorts after both fixed ids.
    organizations(&pool, &app, &[first, second]).await;
    for organization in [first, second] {
        seed_cleanup_sessions(&pool, organization, 1_005).await;
    }
    sqlx::raw_sql(
        "CREATE FUNCTION reject_first() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
         IF OLD.organization_id = '00000000-0000-0000-0000-000000000001' THEN \
         RAISE EXCEPTION 'test cleanup failure'; END IF; RETURN OLD; END $$; \
         CREATE TRIGGER reject_first BEFORE DELETE ON sessions \
         FOR EACH ROW EXECUTE FUNCTION reject_first();",
    )
    .execute(&pool)
    .await
    .unwrap();
    cleanup.trigger(&pool);
    cleanup.finished().await;
    assert_eq!(expired_sessions(&pool, first).await, 1_005);
    assert_eq!(expired_sessions(&pool, second).await, 1_005);
    // The failure is permanent here: a cursor that moved only after a successful
    // DELETE would select the first Organization forever.
    advance_cleanup_interval_and_expire_throttle_window().await;
    cleanup.trigger(&pool);
    cleanup.finished().await;
    assert_eq!(cleanup.started(), 2);
    assert_eq!(expired_sessions(&pool, second).await, 5);
    assert_eq!(expired_sessions(&pool, first).await, 1_005);
}

#[sqlx::test]
async fn cleanup_timeout_does_not_fail_sign_in_and_consumes_the_interval(pool: PgPool) {
    let cleanup = SessionCleanup::default();
    let app = router(&pool, &cleanup);
    let organization = organizations(&pool, &app, &[]).await;
    seed_cleanup_sessions(&pool, organization, 1).await;

    // Exhaust a separate pool to reach the outer cleanup deadline before any SQL
    // can hit the shorter statement timeout. Sign-in keeps its own available pool
    // but shares the cleanup gate, as concurrent requests in the real app do.
    let cleanup_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(DEADLINE + Duration::from_secs(10))
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let holder = cleanup_pool.acquire().await.unwrap();
    let started = Instant::now();
    cleanup.trigger(&cleanup_pool);
    assert!(cleanup.running());

    let response = sign_in(&app, organization).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().contains_key(header::SET_COOKIE));
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32 * 1024).await.unwrap()).unwrap();
    let token = body["token"].as_str().unwrap();
    tokio::time::timeout(DEADLINE + Duration::from_secs(1), cleanup.finished())
        .await
        .expect("cleanup must finish before pool acquisition can time out");
    assert!(started.elapsed() >= DEADLINE);
    assert!(!cleanup.running());
    assert_eq!(cleanup.started(), 1);
    assert_eq!(expired_sessions(&pool, organization).await, 1);
    assert_eq!(
        request(&app, "GET", "/api/v1/me", Value::Null, token)
            .await
            .status(),
        StatusCode::OK
    );
    drop(holder);
    cleanup_pool.close().await;

    assert_eq!(sign_in(&app, organization).await.status(), StatusCode::OK);
    cleanup.finished().await;
    assert_eq!(cleanup.started(), 1);
    advance_cleanup_interval_and_expire_throttle_window().await;
    assert_eq!(sign_in(&app, organization).await.status(), StatusCode::OK);
    cleanup.finished().await;
    assert_eq!(cleanup.started(), 2);
    assert_eq!(expired_sessions(&pool, organization).await, 0);
}

#[sqlx::test]
async fn cleanup_failure_does_not_fail_sign_in_and_is_frequency_limited(pool: PgPool) {
    let cleanup = SessionCleanup::default();
    let app = router(&pool, &cleanup);
    let organization = organizations(&pool, &app, &[]).await;
    seed_cleanup_sessions(&pool, organization, 1).await;
    sqlx::raw_sql(
        "CREATE FUNCTION reject_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN RAISE EXCEPTION 'test cleanup failure'; END $$; \
         CREATE TRIGGER reject_cleanup BEFORE DELETE ON sessions \
         FOR EACH ROW EXECUTE FUNCTION reject_cleanup();",
    )
    .execute(&pool)
    .await
    .unwrap();
    let response = sign_in(&app, organization).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().contains_key(header::SET_COOKIE));
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32 * 1024).await.unwrap()).unwrap();
    let token = body["token"].as_str().unwrap();
    cleanup.finished().await;
    assert_eq!(
        request(&app, "GET", "/api/v1/me", Value::Null, token)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(expired_sessions(&pool, organization).await, 1);
    sqlx::query("DROP TRIGGER reject_cleanup ON sessions")
        .execute(&pool)
        .await
        .unwrap();
    // The failed run consumed the interval.
    assert_eq!(sign_in(&app, organization).await.status(), StatusCode::OK);
    cleanup.finished().await;
    assert_eq!(cleanup.started(), 1);
    assert_eq!(expired_sessions(&pool, organization).await, 1);
    advance_cleanup_interval_and_expire_throttle_window().await;
    assert_eq!(sign_in(&app, organization).await.status(), StatusCode::OK);
    cleanup.finished().await;
    assert_eq!(cleanup.started(), 2);
    assert_eq!(expired_sessions(&pool, organization).await, 0);
}
