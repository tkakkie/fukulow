use super::*;
use std::time::Duration;

#[fukulow_test::test]
async fn security_throttle_shares_failures_with_web_and_native_sign_in(pool: PgPool) {
    let f = fixture(&pool).await;
    let before = snapshot(&pool).await;
    for (method, path) in [
        OPERATIONS[0],
        ("POST", "/api/v1/session"),
        OPERATIONS[1],
        ("POST", "/api/v1/native/session"),
        OPERATIONS[0],
    ] {
        let input = if path.contains("/session") && !path.contains("revoke") {
            json!({"email":" Owner@Example.com ","password":"wrong password"})
        } else {
            body(path, "wrong password")
        };
        let status = if path == "/api/v1/session" || path == "/api/v1/native/session" {
            StatusCode::UNAUTHORIZED
        } else {
            StatusCode::FORBIDDEN
        };
        let code = if status == StatusCode::UNAUTHORIZED {
            "invalid credentials"
        } else {
            "current_password_incorrect"
        };
        error(
            call(&f.app, method, path, Some(&f.current), false, input).await,
            status,
            code,
        )
        .await;
    }
    for (method, path) in [
        OPERATIONS[0],
        OPERATIONS[1],
        ("POST", "/api/v1/session"),
        ("POST", "/api/v1/native/session"),
    ] {
        let input = if path == "/api/v1/session" || path == "/api/v1/native/session" {
            json!({"email":"OWNER@example.com","password":PASSWORD})
        } else {
            body(path, PASSWORD)
        };
        let response = call(&f.app, method, path, Some(&f.current), false, input).await;
        assert!(response.headers().contains_key(header::RETRY_AFTER));
        error(
            response,
            StatusCode::TOO_MANY_REQUESTS,
            "too many sign-in attempts",
        )
        .await;
    }
    assert_eq!(snapshot(&pool).await, before);
}

#[fukulow_test::test]
async fn security_reserves_shared_ip_and_email_before_argon2_admission(pool: PgPool) {
    let f = fixture(&pool).await;
    let before = snapshot(&pool).await;
    let workers: &'static PasswordWorkers = Box::leak(Box::new(PasswordWorkers::new()));
    let _held = workers.running.acquire_many(4).await.unwrap();
    let _queue = workers.waiting.acquire_many(32).await.unwrap();
    for by_ip in [false, true] {
        let throttle = SignInThrottle::default();
        let mut reservations = Vec::new();
        for n in 0..if by_ip { 20 } else { 5 } {
            let ip = if by_ip {
                "192.0.2.1".parse().unwrap()
            } else {
                std::net::IpAddr::from([192, 0, 2, 10 + n])
            };
            let mut attempt = throttle.begin(ip).unwrap();
            if !by_ip {
                attempt.account("owner@example.com".into()).unwrap();
            }
            reservations.push(attempt);
        }
        let app = app_with_workers(
            AppState {
                sign_in_throttle: throttle.clone(),
                ..f.state.clone()
            },
            workers,
        );
        for (method, path) in OPERATIONS {
            let response = tokio::time::timeout(
                Duration::from_secs(1),
                call(
                    &app,
                    method,
                    path,
                    Some(&f.current),
                    false,
                    body(path, PASSWORD),
                ),
            )
            .await
            .unwrap();
            let retry = response.headers()[header::RETRY_AFTER]
                .to_str()
                .unwrap()
                .parse::<u64>()
                .unwrap();
            assert!((1..=60).contains(&retry));
            error(
                response,
                StatusCode::TOO_MANY_REQUESTS,
                "too many sign-in attempts",
            )
            .await;
        }
        assert_eq!(snapshot(&pool).await, before);
        drop(reservations);
        assert_eq!(throttle.pending_counts(), (0, 0));
        // With budgets free, the full Argon2 queue yields 503 and spends no failures.
        for (method, path) in OPERATIONS {
            let response = call(
                &app,
                method,
                path,
                Some(&f.current),
                false,
                body(path, PASSWORD),
            )
            .await;
            assert!(response.headers().contains_key(header::RETRY_AFTER));
            error(
                response,
                StatusCode::SERVICE_UNAVAILABLE,
                "password admission unavailable",
            )
            .await;
        }
        assert_eq!(throttle.pending_counts(), (0, 0));
        for _ in 0..5 {
            let mut attempt = throttle.begin("192.0.2.1".parse().unwrap()).unwrap();
            attempt.account("owner@example.com".into()).unwrap();
            attempt.failed();
        }
    }
    assert_eq!(snapshot(&pool).await, before);
}

#[fukulow_test::test]
async fn security_success_releases_reservations_without_resetting_failures(pool: PgPool) {
    let f = fixture(&pool).await;
    let path = OPERATIONS[1].1;
    error(
        call(
            &f.app,
            "POST",
            path,
            Some(&f.current),
            false,
            body(path, "wrong password"),
        )
        .await,
        StatusCode::FORBIDDEN,
        "current_password_incorrect",
    )
    .await;
    for _ in 0..6 {
        assert_eq!(
            call(
                &f.app,
                "POST",
                path,
                Some(&f.current),
                false,
                body(path, PASSWORD)
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
    }
    assert_eq!(f.state.sign_in_throttle.pending_counts(), (0, 0));
    for _ in 0..4 {
        let mut attempt = f
            .state
            .sign_in_throttle
            .begin("192.0.2.2".parse().unwrap())
            .unwrap();
        attempt.account("owner@example.com".into()).unwrap();
        attempt.failed();
    }
    let mut denied = f
        .state
        .sign_in_throttle
        .begin("192.0.2.3".parse().unwrap())
        .unwrap();
    assert!(denied.account("owner@example.com".into()).is_err());
}

async fn cancelled_argon2(pool: PgPool, operation: usize, correct: bool) {
    let f = fixture(&pool).await;
    let before = snapshot(&pool).await;
    let workers: &'static PasswordWorkers = Box::leak(Box::new(PasswordWorkers::new()));
    let app = app_with_workers(f.state.clone(), workers);
    let (entered, running) = tokio::sync::oneshot::channel();
    let (release, gate) = std::sync::mpsc::channel();
    *workers.on_start.lock().unwrap() = Some(Box::new(move || {
        entered.send(()).unwrap();
        gate.recv_timeout(Duration::from_secs(30)).unwrap();
    }));
    let pending = {
        let app = app.clone();
        let token = f.current.clone();
        tokio::spawn(async move {
            let (method, path) = OPERATIONS[operation];
            call(
                &app,
                method,
                path,
                Some(&token),
                false,
                body(path, if correct { PASSWORD } else { "wrong password" }),
            )
            .await
        })
    };
    running.await.unwrap();
    assert_eq!(f.state.sign_in_throttle.pending_counts(), (1, 1));
    assert_eq!(workers.running.available_permits(), 3);
    let mut reservations = Vec::new();
    for _ in 0..4 {
        let mut attempt = f
            .state
            .sign_in_throttle
            .begin("192.0.2.2".parse().unwrap())
            .unwrap();
        attempt.account("owner@example.com".into()).unwrap();
        reservations.push(attempt);
    }
    for path in ["/api/v1/session", "/api/v1/native/session"] {
        let response = call(
            &app,
            "POST",
            path,
            None,
            false,
            json!({"email":"owner@example.com","password":PASSWORD}),
        )
        .await;
        assert!(response.headers().contains_key(header::RETRY_AFTER));
        error(
            response,
            StatusCode::TOO_MANY_REQUESTS,
            "too many sign-in attempts",
        )
        .await;
    }
    drop(reservations);
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    assert_eq!(f.state.sign_in_throttle.pending_counts(), (1, 1));
    assert_eq!(workers.running.available_permits(), 3);
    release.send(()).unwrap();
    // The running verification retains the Account lock until the detached task finishes.
    let mut finished = pool.begin().await.unwrap();
    super::super::test_support::lock_account(&mut finished, f.account).await;
    finished.commit().await.unwrap();
    assert_eq!(f.state.sign_in_throttle.pending_counts(), (0, 0));
    if !correct {
        assert_eq!(snapshot(&pool).await, before);
    } else {
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM account_sessions WHERE account_id=$1")
                .bind(f.account)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 1);
    }
    // Cancellation accounts exactly one wrong-password failure, and no success failure.
    for _ in 0..if correct { 5 } else { 4 } {
        let mut attempt = f
            .state
            .sign_in_throttle
            .begin("192.0.2.2".parse().unwrap())
            .unwrap();
        attempt.account("owner@example.com".into()).unwrap();
        attempt.failed();
    }
    let mut denied = f
        .state
        .sign_in_throttle
        .begin("192.0.2.3".parse().unwrap())
        .unwrap();
    assert!(denied.account("owner@example.com".into()).is_err());
}

#[fukulow_test::test]
async fn password_change_argon2_reservation_survives_http_cancellation(pool: PgPool) {
    cancelled_argon2(pool, 0, true).await;
}
#[fukulow_test::test]
async fn revoke_others_argon2_reservation_survives_http_cancellation(pool: PgPool) {
    cancelled_argon2(pool, 1, true).await;
}
#[fukulow_test::test]
async fn password_change_cancelled_argon2_failure_counts_without_mutation(pool: PgPool) {
    cancelled_argon2(pool, 0, false).await;
}
#[fukulow_test::test]
async fn revoke_others_cancelled_argon2_failure_counts_without_mutation(pool: PgPool) {
    cancelled_argon2(pool, 1, false).await;
}
