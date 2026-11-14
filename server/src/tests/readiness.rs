use super::*;
use axum::body::to_bytes;
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::sync::atomic::Ordering;

mod relay;
use relay::Relay;

async fn request(router: &Router, path: &str) -> Response {
    router
        .clone()
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn assert_ready(router: &Router) {
    let response = request(router, "/api/v1/ready").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(to_bytes(response.into_body(), 1024).await.unwrap(), "ok");
}

async fn assert_not_ready(router: &Router) {
    let response = request(router, "/api/v1/ready").await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({"error": "not_ready"})
    );
}

#[fukulow_test::test(migrations = false)]
async fn readiness_accepts_not_started_worker(pool: PgPool) {
    let router = app(AppState::with_test_pool(pool));
    assert_ready(&router).await;
}

#[fukulow_test::test(migrations = false)]
async fn readiness_acquire_timeout_recovers_without_changing_liveness(pool: PgPool) {
    let single = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    let router = app(AppState::with_test_pool(single.clone()));
    assert_ready(&router).await;
    let mut connection = single.acquire().await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), assert_not_ready(&router))
        .await
        .expect("readiness must bound pool acquisition");
    let live = request(&router, "/api/v1/health").await;
    assert_eq!(live.status(), StatusCode::OK);
    assert_eq!(to_bytes(live.into_body(), 1024).await.unwrap(), "ok");
    connection.return_to_pool().await;
    assert_ready(&router).await;
    single.close().await;
    assert_not_ready(&router).await;
}

#[fukulow_test::test(migrations = false)]
async fn readiness_query_timeout_releases_slot_limits_flood_and_recovers(pool: PgPool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        let relay = Relay::new(&pool, 1).await;
        let router = app(AppState::with_test_pool(relay.pool.clone()));
        assert_ready(&router).await;
        relay.hold.send(true).unwrap();
        let mut checks = tokio::task::JoinSet::new();
        checks.spawn({
            let router = router.clone();
            async move { assert_not_ready(&router).await }
        });
        relay.blocked.notified().await;
        for _ in 0..16 {
            let router = router.clone();
            checks.spawn(async move { assert_not_ready(&router).await });
        }
        while let Some(result) = checks.join_next().await {
            result.unwrap();
        }
        assert_eq!(
            relay.pool.size(),
            0,
            "query timeout must release the pool slot"
        );
        relay.hold.send(false).unwrap();
        assert_ready(&router).await;
        relay.pool.close().await;
    })
    .await
    .expect("readiness query timeout and recovery must not hang");
}

#[fukulow_test::test(migrations = false)]
async fn readiness_overlapping_healthy_callers_share_one_check(pool: PgPool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        // Spare pool capacity would expose accidentally independent checks.
        let relay = Relay::new(&pool, 4).await;
        let router = app(AppState::with_test_pool(relay.pool.clone()));
        assert_ready(&router).await;
        let before = relay.returns.load(Ordering::SeqCst);
        relay.hold.send(true).unwrap();
        let first = tokio::spawn({
            let router = router.clone();
            async move { assert_ready(&router).await }
        });
        relay.blocked.notified().await;
        let mut calls = Vec::new();
        for _ in 0..16 {
            let mut call = Box::pin(assert_ready(&router));
            // Poll each caller into the same flight before releasing the DB reply.
            std::future::poll_fn(|cx| {
                assert!(call.as_mut().poll(cx).is_pending());
                std::task::Poll::Ready(())
            })
            .await;
            calls.push(call);
        }
        assert!(!first.is_finished());
        relay.hold.send(false).unwrap();
        first.await.unwrap();
        for call in calls {
            call.await;
        }
        assert_eq!(relay.returns.load(Ordering::SeqCst) - before, 1);
        assert_eq!(relay.pool.size() as usize, relay.pool.num_idle());
        relay.pool.close().await;
    })
    .await
    .expect("overlapping healthy checks must complete together");
}

#[fukulow_test::test(migrations = false)]
async fn readiness_bounds_return_ping_without_accumulating_connections(pool: PgPool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let relay = Relay::new(&pool, 4).await;
        let router = app(AppState::with_test_pool(relay.pool.clone()));
        for _ in 0..4 {
            assert_ready(&router).await;
            relay.stall_return.store(true, Ordering::SeqCst);
            let check = tokio::spawn({
                let router = router.clone();
                async move { assert_not_ready(&router).await }
            });
            relay.blocked.notified().await;
            assert!(!check.is_finished(), "admission must cover the return ping");
            check.await.unwrap();
            assert_eq!(relay.pool.size(), 0, "stalled returns must not accumulate");
            relay.hold.send(false).unwrap();
        }
        assert_ready(&router).await;
        relay.pool.close().await;
    })
    .await
    .expect("pool return must have its own deadline");
}

#[fukulow_test::test(migrations = false)]
async fn readiness_cancelled_query_detaches_connection(pool: PgPool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let relay = Relay::new(&pool, 1).await;
        assert!(database::ready(&relay.pool).await);
        relay.hold.send(true).unwrap();
        let check = tokio::spawn({
            let pool = relay.pool.clone();
            async move { database::ready(&pool).await }
        });
        relay.blocked.notified().await;
        check.abort();
        assert!(check.await.unwrap_err().is_cancelled());
        assert_eq!(
            relay.pool.size(),
            0,
            "cancelled query must detach immediately"
        );
        relay.hold.send(false).unwrap();
        assert!(database::ready(&relay.pool).await);
        relay.pool.close().await;
    })
    .await
    .expect("cancellation must release the pool slot");
}

#[fukulow_test::test(migrations = false)]
async fn readiness_cancelled_return_releases_connection(pool: PgPool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let relay = Relay::new(&pool, 1).await;
        relay.stall_return.store(true, Ordering::SeqCst);
        let check = tokio::spawn({
            let pool = relay.pool.clone();
            async move { database::ready(&pool).await }
        });
        relay.blocked.notified().await;
        check.abort();
        assert!(check.await.unwrap_err().is_cancelled());
        assert_eq!(
            relay.pool.size(),
            0,
            "cancelled return must release immediately"
        );
        relay.hold.send(false).unwrap();
        assert!(database::ready(&relay.pool).await);
        relay.pool.close().await;
    })
    .await
    .expect("cancellation must also bound return cleanup");
}

#[fukulow_test::test(migrations = false)]
async fn readiness_query_error_detaches_connection(pool: PgPool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let relay = Relay::new(&pool, 1).await;
        let mut connection = relay.pool.acquire().await.unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
        connection.return_to_pool().await;
        let terminated: bool = sqlx::query_scalar("SELECT pg_terminate_backend($1)")
            .bind(pid)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(terminated);
        assert!(!database::ready(&relay.pool).await);
        assert_eq!(
            relay.pool.size(),
            0,
            "query errors must detach synchronously"
        );
        assert!(database::ready(&relay.pool).await);
        relay.pool.close().await;
    })
    .await
    .expect("query errors must release the pool slot");
}

#[fukulow_test::test(migrations = false)]
async fn readiness_cancelled_caller_keeps_shared_check_until_cleanup(pool: PgPool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let relay = Relay::new(&pool, 4).await;
        let router = app(AppState::with_test_pool(relay.pool.clone()));
        assert_ready(&router).await;
        let before = relay.returns.load(Ordering::SeqCst);
        relay.hold.send(true).unwrap();
        let caller = tokio::spawn({
            let router = router.clone();
            async move { assert_ready(&router).await }
        });
        relay.blocked.notified().await;
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert_eq!(
            relay.pool.size(),
            1,
            "caller cancellation must keep the shared check running"
        );
        let mut next = Box::pin(assert_ready(&router));
        std::future::poll_fn(|cx| {
            assert!(next.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        relay.hold.send(false).unwrap();
        next.await;
        assert_eq!(relay.returns.load(Ordering::SeqCst) - before, 1);
        assert_eq!(relay.pool.size() as usize, relay.pool.num_idle());
        relay.pool.close().await;
    })
    .await
    .expect("caller cancellation must preserve single flight");
}
