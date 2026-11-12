use super::*;
use axum::body::{Body, to_bytes};
use serde_json::{Value, json};
use std::time::Duration;
use tower::ServiceExt;

fn request(path: &str, email: &str, password: &str) -> Request {
    Request::post(path)
        .extension(ConnectInfo(
            "192.0.2.1:1234".parse::<std::net::SocketAddr>().unwrap(),
        ))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({"email": email, "password": password}).to_string(),
        ))
        .unwrap()
}

async fn assert_unavailable(response: Response) {
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(!response.headers().contains_key(header::SET_COOKIE));
    let retry: u64 = response.headers()[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=5).contains(&retry));
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"error": "password admission unavailable"})
    );
}

async fn wait_for_queue(workers: &PasswordWorkers, available: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while workers.waiting.available_permits() != available {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn assert_no_sessions(pool: &sqlx::PgPool) {
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM account_sessions")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[sqlx::test]
async fn full_queue_returns_same_503_for_known_and_unknown_accounts(pool: sqlx::PgPool) {
    let state = credential_tests::fixture(pool.clone()).await;
    let workers: &'static PasswordWorkers = Box::leak(Box::new(PasswordWorkers::new()));
    let held = workers.running.acquire_many(4).await.unwrap();
    let capacity = workers.waiting.available_permits();
    let queued = workers.waiting.acquire_many(capacity as u32).await.unwrap();
    let app = tests::app_with_workers(state.clone(), workers);
    for path in ["/api/v1/session", "/api/v1/native/session"] {
        for email in ["owner@example.com", "unknown@example.com"] {
            let response = tokio::time::timeout(
                Duration::from_millis(500),
                app.clone()
                    .oneshot(request(path, email, "incorrect password")),
            )
            .await
            .expect("a full queue must reject immediately")
            .unwrap();
            assert_unavailable(response).await;
            assert_eq!(state.sign_in_throttle.pending_counts(), (0, 0));
        }
    }
    assert_no_sessions(&pool).await;
    drop(queued);
    assert_eq!(workers.waiting.available_permits(), capacity);
    drop(held);
    assert_eq!(workers.running.available_permits(), 4);
}

#[sqlx::test]
async fn expired_wait_returns_503_without_spending_failure_budget(pool: sqlx::PgPool) {
    let state = credential_tests::fixture(pool.clone()).await;
    let workers: &'static PasswordWorkers = Box::leak(Box::new(PasswordWorkers::new()));
    let held = workers.running.acquire_many(4).await.unwrap();
    let capacity = workers.waiting.available_permits();
    let app = tests::app_with_workers(state.clone(), workers);
    for path in ["/api/v1/session", "/api/v1/native/session"] {
        let start = tokio::time::Instant::now();
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            app.clone()
                .oneshot(request(path, "owner@example.com", "incorrect password")),
        )
        .await
        .unwrap()
        .unwrap();
        assert_unavailable(response).await;
        assert!(start.elapsed() >= Duration::from_secs(1));
        assert_eq!(workers.waiting.available_permits(), capacity);
        assert_eq!(state.sign_in_throttle.pending_counts(), (0, 0));
    }
    assert_no_sessions(&pool).await;
    // Rejected admission must leave all five credential failures available.
    for _ in 0..5 {
        let mut attempt = state
            .sign_in_throttle
            .begin("192.0.2.1".parse().unwrap())
            .unwrap();
        attempt.account("owner@example.com".into()).unwrap();
        attempt.failed();
    }
    drop(held);
}

#[sqlx::test]
async fn successful_and_unknown_sign_ins_share_bounded_workers(pool: sqlx::PgPool) {
    let state = credential_tests::fixture(pool).await;
    let workers: &'static PasswordWorkers = Box::leak(Box::new(PasswordWorkers::new()));
    let capacity = workers.waiting.available_permits();
    let app = tests::app_with_workers(state.clone(), workers);
    for path in ["/api/v1/session", "/api/v1/native/session"] {
        for email in ["owner@example.com", "unknown@example.com"] {
            let held = workers.running.acquire_many(4).await.unwrap();
            let task = tokio::spawn(app.clone().oneshot(request(
                path,
                email,
                "correct horse battery staple",
            )));
            wait_for_queue(workers, capacity - 1).await;
            assert_eq!(state.sign_in_throttle.pending_counts(), (1, 1));
            drop(held);
            let response = task.await.unwrap().unwrap();
            assert_eq!(workers.running.available_permits(), 4);
            assert_eq!(workers.waiting.available_permits(), capacity);
            assert_eq!(state.sign_in_throttle.pending_counts(), (0, 0));
            if email == "owner@example.com" {
                assert_eq!(response.status(), StatusCode::OK);
                assert_eq!(
                    response.headers().contains_key(header::SET_COOKIE),
                    path == "/api/v1/session"
                );
                let body = to_bytes(response.into_body(), 4096).await.unwrap();
                let body: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(body["identity"]["account"]["email"], email);
                assert_eq!(
                    body.get("token").is_some(),
                    path == "/api/v1/native/session"
                );
            } else {
                assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
                let body = to_bytes(response.into_body(), 1024).await.unwrap();
                assert_eq!(
                    serde_json::from_slice::<Value>(&body).unwrap(),
                    json!({"error": "invalid credentials"})
                );
            }
        }
    }
}

#[sqlx::test]
async fn cancelled_running_sign_in_retains_permits_and_accounts_failures(pool: sqlx::PgPool) {
    let state = credential_tests::fixture(pool.clone()).await;
    let workers: &'static PasswordWorkers = Box::leak(Box::new(PasswordWorkers::new()));
    for (email, password, failed) in [
        ("owner@example.com", "correct horse battery staple", false),
        ("owner@example.com", "incorrect password", true),
        ("unknown@example.com", "incorrect password", true),
    ] {
        let state = AppState {
            sign_in_throttle: SignInThrottle::default(),
            ..state.clone()
        };
        let app = tests::app_with_workers(state.clone(), workers);
        let held = workers.running.acquire_many(3).await.unwrap();
        let (started, running) = tokio::sync::oneshot::channel();
        let (release, gate) = std::sync::mpsc::channel();
        *workers.on_start.lock().unwrap() = Some(Box::new(move || {
            started.send(()).unwrap();
            gate.recv_timeout(Duration::from_secs(10)).unwrap();
        }));
        let task = tokio::spawn(app.clone().oneshot(request(
            "/api/v1/native/session",
            email,
            password,
        )));
        tokio::time::timeout(Duration::from_secs(5), running)
            .await
            .unwrap()
            .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(workers.running.available_permits(), 0);
        assert_eq!(state.sign_in_throttle.pending_counts(), (1, 1));
        assert_no_sessions(&pool).await;
        release.send(()).unwrap();
        let completed = tokio::time::timeout(Duration::from_secs(5), workers.running.acquire())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(state.sign_in_throttle.pending_counts(), (0, 0));
        assert_no_sessions(&pool).await;
        drop((held, completed));
        // Cancellation charges exactly one failure iff password verification fails.
        for _ in 0..5 - u32::from(failed) {
            let mut attempt = state
                .sign_in_throttle
                .begin("192.0.2.2".parse().unwrap())
                .unwrap();
            attempt.account(email.into()).unwrap();
            attempt.failed();
        }
        let mut rejected = state
            .sign_in_throttle
            .begin("192.0.2.3".parse().unwrap())
            .unwrap();
        assert!(rejected.account(email.into()).is_err());
        drop(rejected);
    }
}

#[sqlx::test]
async fn unknown_email_key_exhaustion_still_allows_legitimate_sign_in(pool: sqlx::PgPool) {
    let state = credential_tests::fixture(pool).await;
    // Seed the state left by failed unknown-email checks, without 10,000 Argon2 calls.
    for n in 0..throttle::MAX_KEYS as u32 {
        let mut attempt = state
            .sign_in_throttle
            .begin(std::net::IpAddr::from(n.to_be_bytes()))
            .unwrap();
        attempt.account(format!("unknown-{n}@example.com")).unwrap();
        attempt.failed();
    }
    let response = crate::app(state)
        .oneshot(request(
            "/api/v1/session",
            "owner@example.com",
            "correct horse battery staple",
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().contains_key(header::SET_COOKIE));
}

// Keep admission/cancellation regressions runnable even without PostgreSQL.
const STORED_PASSWORD: &str = "$argon2id$v=19$m=19456,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$gy5SuVm5Z7Vw7keB9se9p87QGcomaseB/S2U1OhTsM0";

#[tokio::test(start_paused = true)]
async fn password_admission_rejections_preserve_known_and_unknown_failure_budgets() {
    let workers: &'static PasswordWorkers = Box::leak(Box::new(PasswordWorkers::new()));
    let held = workers.running.acquire_many(4).await.unwrap();
    let capacity = workers.waiting.available_permits();
    for full in [true, false] {
        let queued = if full {
            Some(workers.waiting.acquire_many(capacity as u32).await.unwrap())
        } else {
            None
        };
        for stored in [Some(STORED_PASSWORD.to_owned()), None] {
            let throttle = SignInThrottle::default();
            let mut attempt = throttle.begin("192.0.2.1".parse().unwrap()).unwrap();
            attempt.account("test@example.com".into()).unwrap();
            let start = tokio::time::Instant::now();
            let error = check_password("incorrect password".into(), stored, attempt, workers)
                .await
                .unwrap_err();
            assert_unavailable(error.into_response()).await;
            assert_eq!(
                start.elapsed(),
                if full {
                    Duration::ZERO
                } else {
                    Duration::from_secs(1)
                }
            );
            assert_eq!(throttle.pending_counts(), (0, 0));
            for _ in 0..5 {
                let mut attempt = throttle.begin("192.0.2.1".parse().unwrap()).unwrap();
                attempt.account("test@example.com".into()).unwrap();
                attempt.failed();
            }
            let mut rejected = throttle.begin("192.0.2.1".parse().unwrap()).unwrap();
            assert!(rejected.account("test@example.com".into()).is_err());
        }
        drop(queued);
        assert_eq!(workers.waiting.available_permits(), capacity);
    }
    drop(held);
    assert_eq!(workers.running.available_permits(), 4);
}

#[tokio::test]
async fn cancelled_password_work_retains_capacity_and_finishes_throttle_accounting() {
    let workers: &'static PasswordWorkers = Box::leak(Box::new(PasswordWorkers::new()));
    for (stored, password, failed) in [
        (
            Some(STORED_PASSWORD.to_owned()),
            "correct horse battery staple",
            false,
        ),
        (Some(STORED_PASSWORD.to_owned()), "incorrect password", true),
        (None, "incorrect password", true),
    ] {
        let throttle = SignInThrottle::default();
        let mut attempt = throttle.begin("192.0.2.1".parse().unwrap()).unwrap();
        attempt.account("test@example.com".into()).unwrap();
        let held = workers.running.acquire_many(3).await.unwrap();
        let (started, running) = tokio::sync::oneshot::channel();
        let (release, gate) = std::sync::mpsc::channel();
        *workers.on_start.lock().unwrap() = Some(Box::new(move || {
            started.send(()).unwrap();
            gate.recv_timeout(Duration::from_secs(10)).unwrap();
        }));
        let task = tokio::spawn(check_password(password.into(), stored, attempt, workers));
        tokio::time::timeout(Duration::from_secs(5), running)
            .await
            .unwrap()
            .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(workers.running.available_permits(), 0);
        assert_eq!(throttle.pending_counts(), (1, 1));
        release.send(()).unwrap();
        let completed = tokio::time::timeout(Duration::from_secs(5), workers.running.acquire())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(throttle.pending_counts(), (0, 0));
        drop((held, completed));
        for _ in 0..5 - u32::from(failed) {
            let mut attempt = throttle.begin("192.0.2.2".parse().unwrap()).unwrap();
            attempt.account("test@example.com".into()).unwrap();
            attempt.failed();
        }
        let mut rejected = throttle.begin("192.0.2.3".parse().unwrap()).unwrap();
        assert!(rejected.account("test@example.com".into()).is_err());
    }
}
