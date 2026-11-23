use super::throttle::{throttled, wrong_current_password};
use super::*;
use std::time::Duration;

pub(super) async fn account_waiters<'e>(executor: impl sqlx::PgExecutor<'e>) -> (i64, i64) {
    sqlx::query_as(
        "SELECT count(*) FILTER (WHERE query LIKE 'SELECT id, password_hash FROM accounts%'),
                count(*) FILTER (WHERE query LIKE 'SELECT password_hash FROM accounts%')
         FROM pg_stat_activity WHERE datname = current_database()
         AND wait_event_type = 'Lock' AND wait_event IN ('tuple', 'transactionid')
         AND query LIKE '%FOR UPDATE'",
    )
    .fetch_one(executor)
    .await
    .unwrap()
}

async fn waiting_for_account(pool: &PgPool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if account_waiters(pool).await.1 > 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

pub(super) fn gate_password_check(
    workers: &PasswordWorkers,
) -> (
    std::sync::mpsc::Sender<()>,
    tokio::sync::oneshot::Receiver<()>,
) {
    let (entered, running) = tokio::sync::oneshot::channel();
    let (release, gate) = std::sync::mpsc::channel();
    *workers.on_start.lock().unwrap() = Some(Box::new(move || {
        entered.send(()).unwrap();
        // Dropping the sender on a test failure also unblocks the worker.
        assert_ne!(
            gate.recv_timeout(Duration::from_secs(30)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        );
    }));
    (release, running)
}

async fn sign_in_overlap(pool: PgPool, operation: usize, native: bool) {
    let f = fixture(&pool).await;
    let workers: &'static PasswordWorkers = Box::leak(Box::new(PasswordWorkers::new()));
    let app = app_with_workers(f.state.clone(), workers);
    let (release, running) = gate_password_check(workers);
    let sign_in = {
        let app = app.clone();
        tokio::spawn(async move {
            let path = if native {
                "/api/v1/native/session"
            } else {
                "/api/v1/session"
            };
            call(
                &app,
                "POST",
                path,
                None,
                false,
                json!({"email":"owner@example.com","password":PASSWORD}),
            )
            .await
        })
    };
    tokio::time::timeout(Duration::from_secs(10), running)
        .await
        .unwrap()
        .unwrap();
    // Argon2 has started while holding the Account lock; revocation must wait.
    let revoke = {
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
                body(path, PASSWORD),
            )
            .await
        })
    };
    waiting_for_account(&pool).await;
    assert!(!revoke.is_finished());
    release.send(()).unwrap();
    let response = sign_in.await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let issued = if native {
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        serde_json::from_slice::<Value>(&bytes).unwrap()["token"]
            .as_str()
            .unwrap()
            .to_owned()
    } else {
        response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .strip_prefix("fukulow_session=")
            .unwrap()
            .to_owned()
    };
    assert_eq!(revoke.await.unwrap().status(), StatusCode::NO_CONTENT);
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM account_sessions WHERE account_id=$1")
            .bind(f.account)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
    error(
        call(
            &f.app,
            "GET",
            "/api/v1/me",
            Some(&issued),
            !native,
            Value::Null,
        )
        .await,
        StatusCode::UNAUTHORIZED,
        "invalid credentials",
    )
    .await;
    assert_eq!(
        call(
            &f.app,
            "GET",
            "/api/v1/me",
            Some(&f.current),
            false,
            Value::Null
        )
        .await
        .status(),
        StatusCode::OK
    );
}

#[fukulow_test::test]
async fn password_change_serializes_web_sign_in_before_verification(pool: PgPool) {
    sign_in_overlap(pool, 0, false).await;
}
#[fukulow_test::test]
async fn password_change_serializes_native_sign_in_before_verification(pool: PgPool) {
    sign_in_overlap(pool, 0, true).await;
}
#[fukulow_test::test]
async fn revoke_others_serializes_web_sign_in_before_verification(pool: PgPool) {
    sign_in_overlap(pool, 1, false).await;
}
#[fukulow_test::test]
async fn revoke_others_serializes_native_sign_in_before_verification(pool: PgPool) {
    sign_in_overlap(pool, 1, true).await;
}

#[fukulow_test::test]
async fn security_rechecks_session_after_account_lock_before_argon2(pool: PgPool) {
    let f = fixture(&pool).await;
    for (method, path) in OPERATIONS {
        let mut blocker = pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
            .bind(f.account)
            .execute(&mut *blocker)
            .await
            .unwrap();
        let pending = {
            let app = f.app.clone();
            let token = f.current.clone();
            tokio::spawn(async move {
                call(
                    &app,
                    method,
                    path,
                    Some(&token),
                    false,
                    body(path, PASSWORD),
                )
                .await
            })
        };
        waiting_for_account(&pool).await;
        sqlx::query("UPDATE account_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1")
            .bind(Sha256::digest(f.current.as_bytes()).to_vec()).execute(&mut *blocker).await.unwrap();
        blocker.commit().await.unwrap();
        let before = snapshot(&pool).await;
        error(
            pending.await.unwrap(),
            StatusCode::UNAUTHORIZED,
            "invalid credentials",
        )
        .await;
        assert_eq!(snapshot(&pool).await, before);
        assert_eq!(f.security_counts(&f.current), ((0, 0), (0, 0)));
        sqlx::query("UPDATE account_sessions SET expires_at=clock_timestamp()+interval '30 days' WHERE token_hash=$1")
            .bind(Sha256::digest(f.current.as_bytes()).to_vec()).execute(&pool).await.unwrap();
    }
}

#[fukulow_test::test]
async fn security_rechecks_password_after_account_lock(pool: PgPool) {
    let f = fixture(&pool).await;
    for (method, path) in OPERATIONS {
        let mut blocker = pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
            .bind(f.account)
            .execute(&mut *blocker)
            .await
            .unwrap();
        let pending = {
            let app = f.app.clone();
            let token = f.current.clone();
            tokio::spawn(async move {
                call(
                    &app,
                    method,
                    path,
                    Some(&token),
                    false,
                    body(path, PASSWORD),
                )
                .await
            })
        };
        waiting_for_account(&pool).await;
        let hash = auth::hash_password(NEW_PASSWORD.into(), &auth::PASSWORD_WORKERS)
            .await
            .unwrap();
        sqlx::query("UPDATE accounts SET password_hash=$2 WHERE id=$1")
            .bind(f.account)
            .bind(hash)
            .execute(&mut *blocker)
            .await
            .unwrap();
        blocker.commit().await.unwrap();
        let before = snapshot(&pool).await;
        error(
            pending.await.unwrap(),
            StatusCode::FORBIDDEN,
            "current_password_incorrect",
        )
        .await;
        assert_eq!(snapshot(&pool).await, before);
    }
}

#[fukulow_test::test]
async fn security_operations_serialize_and_reject_a_revoked_current_session(pool: PgPool) {
    let f = fixture(&pool).await;
    let workers: &'static PasswordWorkers = Box::leak(Box::new(PasswordWorkers::new()));
    let app = app_with_workers(f.state.clone(), workers);
    let (release, running) = gate_password_check(workers);
    let first = {
        let app = app.clone();
        let token = f.current.clone();
        tokio::spawn(async move {
            call(
                &app,
                "PUT",
                OPERATIONS[0].1,
                Some(&token),
                false,
                body(OPERATIONS[0].1, PASSWORD),
            )
            .await
        })
    };
    running.await.unwrap();
    let second = {
        let app = app.clone();
        let token = f.bearer.clone();
        tokio::spawn(async move {
            call(
                &app,
                "POST",
                OPERATIONS[1].1,
                Some(&token),
                false,
                body(OPERATIONS[1].1, PASSWORD),
            )
            .await
        })
    };
    waiting_for_account(&pool).await;
    release.send(()).unwrap();
    assert_eq!(first.await.unwrap().status(), StatusCode::NO_CONTENT);
    error(
        second.await.unwrap(),
        StatusCode::UNAUTHORIZED,
        "invalid credentials",
    )
    .await;
    assert_eq!(f.security_counts(&f.bearer), ((0, 0), (0, 0)));
}

#[fukulow_test::test]
async fn concurrent_authenticated_attempts_reserve_the_last_account_slot(pool: PgPool) {
    let f = fixture(&pool).await;
    let before = snapshot(&pool).await;
    for n in 0..SECURITY_ACCOUNT_LIMIT - 1 {
        let credential = if n % 2 == 0 { &f.current } else { &f.cookie };
        wrong_current_password(&f.app, n as usize % OPERATIONS.len(), credential, false).await;
    }
    let mut blocker = pool.begin().await.unwrap();
    super::super::test_support::lock_account(&mut blocker, f.account).await;
    let admitted = tokio::spawn({
        let app = f.app.clone();
        let token = f.bearer.clone();
        async move { wrong_current_password(&app, 0, &token, false).await }
    });
    waiting_for_account(&pool).await;
    assert_eq!(
        f.security_counts(&f.bearer),
        ((0, 1), (SECURITY_ACCOUNT_LIMIT - 1, 1))
    );
    let (method, path) = OPERATIONS[1];
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        call(
            &f.app,
            method,
            path,
            Some(&f.current),
            false,
            body(path, PASSWORD),
        ),
    )
    .await
    .unwrap();
    throttled(response).await;
    assert_eq!(account_waiters(&pool).await, (0, 1));
    blocker.commit().await.unwrap();
    admitted.await.unwrap();
    assert_eq!(
        f.security_counts(&f.bearer),
        ((1, 0), (SECURITY_ACCOUNT_LIMIT, 0))
    );
    assert_eq!(snapshot(&pool).await, before);
}
