use super::{concurrency::gate_password_check, *};
use std::time::Duration;

const SIGN_IN_PATHS: [&str; 2] = ["/api/v1/session", "/api/v1/native/session"];

pub(super) async fn wrong_current_password(
    app: &Router,
    operation: usize,
    token: &str,
    cookie: bool,
) {
    let (method, path) = OPERATIONS[operation];
    error(
        call(
            app,
            method,
            path,
            Some(token),
            cookie,
            body(path, "wrong password"),
        )
        .await,
        StatusCode::FORBIDDEN,
        "current_password_incorrect",
    )
    .await;
}

pub(super) async fn throttled(response: Response) {
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

async fn authenticated_attempt(
    app: &Router,
    operation: usize,
    token: &str,
    password: &str,
) -> Response {
    let (method, path) = OPERATIONS[operation];
    call(app, method, path, Some(token), false, body(path, password)).await
}

async fn sign_in(app: &Router, path: &str, email: &str, password: &str) -> Response {
    call(
        app,
        "POST",
        path,
        None,
        false,
        json!({"email":email,"password":password}),
    )
    .await
}

#[fukulow_test::test]
async fn same_ip_sign_in_failures_do_not_block_revoke_others_or_password_change(pool: PgPool) {
    let f = fixture(&pool).await;
    for path in SIGN_IN_PATHS.into_iter().cycle().take(5) {
        error(
            sign_in(&f.app, path, " Owner@Example.com ", "wrong password").await,
            StatusCode::UNAUTHORIZED,
            "invalid credentials",
        )
        .await;
    }
    // Fill the rest of the same IP's budget as unrelated failed sign-ins would.
    for _ in 0..15 {
        f.state
            .sign_in_throttle
            .begin("192.0.2.1".parse().unwrap())
            .unwrap()
            .failed();
    }
    for path in SIGN_IN_PATHS {
        throttled(sign_in(&f.app, path, "owner@example.com", PASSWORD).await).await;
    }
    assert_eq!(f.security_counts(&f.current), ((0, 0), (0, 0)));
    for operation in [1, 0] {
        assert_eq!(
            authenticated_attempt(&f.app, operation, &f.current, PASSWORD)
                .await
                .status(),
            StatusCode::NO_CONTENT,
        );
    }
}

#[fukulow_test::test]
async fn authenticated_failures_do_not_consume_sign_in_ip_or_email_budgets(pool: PgPool) {
    let f = fixture(&pool).await;
    for (token, count) in [
        (&f.current, SECURITY_SESSION_LIMIT),
        (&f.bearer, SECURITY_ACCOUNT_LIMIT - SECURITY_SESSION_LIMIT),
    ] {
        for n in 0..count {
            wrong_current_password(&f.app, n as usize % OPERATIONS.len(), token, false).await;
        }
    }
    for _ in 0..15 {
        f.state
            .sign_in_throttle
            .begin("192.0.2.1".parse().unwrap())
            .unwrap()
            .failed();
    }
    // Each of the five requests requires both an IP and a normalized-email slot.
    for path in SIGN_IN_PATHS.into_iter().cycle().take(5) {
        error(
            sign_in(&f.app, path, " Owner@Example.com ", "wrong password").await,
            StatusCode::UNAUTHORIZED,
            "invalid credentials",
        )
        .await;
    }
    for path in SIGN_IN_PATHS {
        throttled(sign_in(&f.app, path, "owner@example.com", PASSWORD).await).await;
    }
}

#[fukulow_test::test]
async fn authenticated_failures_stop_at_session_limit_then_shared_account_limit(pool: PgPool) {
    let f = fixture(&pool).await;
    let before = snapshot(&pool).await;
    for n in 0..SECURITY_SESSION_LIMIT {
        // Cookie and bearer presentations of one Session use the same budget.
        wrong_current_password(
            &f.app,
            n as usize % OPERATIONS.len(),
            &f.current,
            n % 2 == 0,
        )
        .await;
    }
    for operation in 0..OPERATIONS.len() {
        throttled(authenticated_attempt(&f.app, operation, &f.current, PASSWORD).await).await;
    }
    for _ in SECURITY_SESSION_LIMIT..SECURITY_ACCOUNT_LIMIT {
        wrong_current_password(&f.app, 1, &f.bearer, false).await;
    }
    for operation in 0..OPERATIONS.len() {
        throttled(authenticated_attempt(&f.app, operation, &f.cookie, PASSWORD).await).await;
    }
    assert_eq!(
        f.security_counts(&f.cookie),
        ((0, 0), (SECURITY_ACCOUNT_LIMIT, 0))
    );
    assert_eq!(snapshot(&pool).await, before);
}

#[fukulow_test::test]
async fn stolen_session_failures_spend_the_owner_account_budget_and_stop_at_its_limit(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    // The owner and stolen Session both have Session capacity when the Account fills.
    let owner_failures = SECURITY_ACCOUNT_LIMIT - SECURITY_SESSION_LIMIT + 1;
    for _ in 0..owner_failures {
        wrong_current_password(&f.app, 0, &f.current, false).await;
    }
    for _ in owner_failures..SECURITY_ACCOUNT_LIMIT {
        wrong_current_password(&f.app, 1, &f.bearer, false).await;
    }
    let stolen_failures = SECURITY_ACCOUNT_LIMIT - owner_failures;
    assert!(stolen_failures < SECURITY_SESSION_LIMIT);
    throttled(authenticated_attempt(&f.app, 0, &f.bearer, "wrong password").await).await;
    throttled(authenticated_attempt(&f.app, 1, &f.cookie, PASSWORD).await).await;
    assert_eq!(
        f.security_counts(&f.bearer),
        ((stolen_failures, 0), (SECURITY_ACCOUNT_LIMIT, 0))
    );
}

#[fukulow_test::test]
async fn authenticated_budgets_isolate_accounts_and_span_organization_memberships(pool: PgPool) {
    let f = fixture(&pool).await;
    let other_account =
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM accounts WHERE email = 'other@example.com'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let org_a = Uuid::new_v4();
    let org_b = Uuid::new_v4();
    for org in [org_a, org_b] {
        sqlx::query(
            "INSERT INTO organizations (organization_id, name) VALUES ($1, 'Organization')",
        )
        .bind(org)
        .execute(&pool)
        .await
        .unwrap();
    }
    for (org, account, credential) in [
        (org_a, f.account, &f.current),
        (org_b, f.account, &f.bearer),
        (org_a, other_account, &f.other),
    ] {
        sqlx::query("INSERT INTO users (organization_id, id, account_id, name, role) VALUES ($1, $2, $3, 'Member', 'member')")
            .bind(org).bind(Uuid::new_v4()).bind(account).execute(&pool).await.unwrap();
        let path = format!("/api/v1/orgs/{org}/me");
        assert_eq!(
            call(&f.app, "GET", &path, Some(credential), false, Value::Null)
                .await
                .status(),
            StatusCode::OK
        );
    }

    for _ in 0..SECURITY_SESSION_LIMIT {
        wrong_current_password(&f.app, 0, &f.current, false).await;
    }
    for _ in SECURITY_SESSION_LIMIT..SECURITY_ACCOUNT_LIMIT {
        wrong_current_password(&f.app, 1, &f.bearer, false).await;
    }
    throttled(authenticated_attempt(&f.app, 1, &f.bearer, PASSWORD).await).await;
    wrong_current_password(&f.app, 0, &f.other, false).await;
    assert_eq!(
        authenticated_attempt(&f.app, 1, &f.other, PASSWORD)
            .await
            .status(),
        StatusCode::NO_CONTENT,
    );
    assert_eq!(
        f.state
            .account_security_throttle
            .counts(&Sha256::digest(f.other.as_bytes()), other_account),
        ((1, 0), (1, 0))
    );
    throttled(authenticated_attempt(&f.app, 0, &f.cookie, PASSWORD).await).await;
}

fn reserve_security(f: &Fixture, token: &str) -> SecurityAttempt {
    f.state
        .account_security_throttle
        .begin(Sha256::digest(token.as_bytes()).to_vec(), f.account)
        .unwrap()
}

#[fukulow_test::test]
async fn security_reserves_session_and_account_capacity_before_argon2_admission(pool: PgPool) {
    let f = fixture(&pool).await;
    let before = snapshot(&pool).await;
    let workers: &'static PasswordWorkers = Box::leak(Box::new(PasswordWorkers::new()));
    let _held = workers.running.acquire_many(4).await.unwrap();
    let _queue = workers.waiting.acquire_many(32).await.unwrap();
    let app = app_with_workers(f.state.clone(), workers);

    let mut reservations: Vec<_> = (0..SECURITY_SESSION_LIMIT)
        .map(|_| reserve_security(&f, &f.current))
        .collect();
    for operation in 0..OPERATIONS.len() {
        throttled(authenticated_attempt(&app, operation, &f.current, PASSWORD).await).await;
    }

    reservations.extend(
        (SECURITY_SESSION_LIMIT..SECURITY_ACCOUNT_LIMIT).map(|_| reserve_security(&f, &f.cookie)),
    );
    for operation in 0..OPERATIONS.len() {
        throttled(authenticated_attempt(&app, operation, &f.bearer, PASSWORD).await).await;
    }
    drop(reservations);

    for operation in 0..OPERATIONS.len() {
        let response = authenticated_attempt(&app, operation, &f.current, PASSWORD).await;
        assert!(response.headers().contains_key(header::RETRY_AFTER));
        error(
            response,
            StatusCode::SERVICE_UNAVAILABLE,
            "password admission unavailable",
        )
        .await;
    }
    assert_eq!(f.security_counts(&f.current), ((0, 0), (0, 0)));
    assert_eq!(f.security_counts(&f.bearer), ((0, 0), (0, 0)));
    assert_eq!(snapshot(&pool).await, before);
}

#[fukulow_test::test]
async fn security_success_releases_reservations_without_resetting_failures(pool: PgPool) {
    let f = fixture(&pool).await;
    wrong_current_password(&f.app, 1, &f.current, false).await;
    for _ in 0..6 {
        assert_eq!(
            authenticated_attempt(&f.app, 1, &f.current, PASSWORD)
                .await
                .status(),
            StatusCode::NO_CONTENT,
        );
        assert_eq!(f.security_counts(&f.current), ((1, 0), (1, 0)));
    }
}

async fn cancelled_argon2(pool: PgPool, operation: usize, correct: bool) {
    let f = fixture(&pool).await;
    let before = snapshot(&pool).await;
    let workers: &'static PasswordWorkers = Box::leak(Box::new(PasswordWorkers::new()));
    let app = app_with_workers(f.state.clone(), workers);
    let (release, running) = gate_password_check(workers);
    let pending = {
        let app = app.clone();
        let token = f.current.clone();
        tokio::spawn(async move {
            authenticated_attempt(
                &app,
                operation,
                &token,
                if correct { PASSWORD } else { "wrong password" },
            )
            .await
        })
    };
    tokio::time::timeout(Duration::from_secs(10), running)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(f.security_counts(&f.current), ((0, 1), (0, 1)));
    assert_eq!(workers.running.available_permits(), 3);
    let reservations: Vec<_> = (1..SECURITY_ACCOUNT_LIMIT)
        .map(|n| {
            reserve_security(
                &f,
                if n < SECURITY_SESSION_LIMIT {
                    &f.current
                } else {
                    &f.cookie
                },
            )
        })
        .collect();
    for operation in 0..OPERATIONS.len() {
        throttled(authenticated_attempt(&app, operation, &f.bearer, PASSWORD).await).await;
    }
    drop(reservations);
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    assert_eq!(f.security_counts(&f.current), ((0, 1), (0, 1)));
    assert_eq!(workers.running.available_permits(), 3);
    release.send(()).unwrap();
    // The running verification retains the Account lock until the detached task finishes.
    let mut finished = pool.begin().await.unwrap();
    super::super::test_support::lock_account(&mut finished, f.account).await;
    finished.commit().await.unwrap();
    let failures = u32::from(!correct);
    assert_eq!(
        f.security_counts(&f.current),
        ((failures, 0), (failures, 0))
    );
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
