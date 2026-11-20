use super::{
    concurrency::{account_waiters, gate_password_check},
    *,
};
use crate::auth::admission_tests::without_time_advance;
use sqlx::{
    Connection, PgConnection,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use std::{
    future::{Future, poll_fn},
    net::SocketAddr,
    sync::mpsc,
    time::Duration,
};
use tokio::task::JoinSet;

const EMAIL_BUDGET: u8 = 5;
const MAX_ACCOUNT_WAITERS: i64 = 7;
const SIGN_IN: &str = "/api/v1/session";

async fn wrong_sign_in(app: &Router, client: u8) -> Response {
    let mut req = request(
        "POST",
        SIGN_IN,
        None,
        false,
        json!({"email":"owner@example.com","password":"wrong password"}),
    );
    req.extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([192, 0, 2, client], 1234))));
    app.clone().oneshot(req).await.unwrap()
}

async fn owner_sign_in(app: &Router, password: &str) -> Response {
    call(
        app,
        "POST",
        SIGN_IN,
        None,
        false,
        json!({"email":"owner@example.com","password":password}),
    )
    .await
}

async fn owner_changes_password(app: &Router, token: &str) -> Response {
    let (method, path) = OPERATIONS[0];
    call(app, method, path, Some(token), true, body(path, PASSWORD)).await
}

struct WrongPasswords {
    release: mpsc::Sender<()>,
    requests: JoinSet<Response>,
}

impl WrongPasswords {
    async fn start(app: &Router, workers: &PasswordWorkers, count: u8) -> Self {
        let (release, running) = gate_password_check(workers);
        let mut requests = JoinSet::new();
        let first = app.clone();
        requests.spawn(async move { wrong_sign_in(&first, 2).await });
        running.await.unwrap();
        for client in 3..=count + 1 {
            let app = app.clone();
            requests.spawn(async move { wrong_sign_in(&app, client).await });
        }
        Self { release, requests }
    }

    async fn finish(mut self) {
        self.release.send(()).unwrap();
        while let Some(response) = self.requests.join_next().await {
            error(
                response.unwrap(),
                StatusCode::UNAUTHORIZED,
                "invalid credentials",
            )
            .await;
        }
    }
}

async fn wait_for_backends(observer: &mut PgConnection, expected: (i64, i64)) {
    // The isolated database only receives Account lock requests for the fixture owner.
    loop {
        let actual = account_waiters(&mut *observer).await;
        assert!(actual.0 + actual.1 <= MAX_ACCOUNT_WAITERS, "{actual:?}");
        if actual == expected {
            return;
        }
        tokio::task::yield_now().await;
    }
}

fn connections_in_use(pool: &PgPool) -> usize {
    (pool.size() as usize).saturating_sub(pool.num_idle())
}

async fn sample_pool_peak<F: Future>(pool: &PgPool, future: F) -> (F::Output, usize) {
    let mut peak = connections_in_use(pool);
    let mut future = std::pin::pin!(future);
    let output = poll_fn(|cx| {
        let result = future.as_mut().poll(cx);
        peak = peak.max(connections_in_use(pool));
        result
    })
    .await;
    (output, peak)
}

async fn throttle_error(response: Response) {
    assert!(response.headers().contains_key(header::RETRY_AFTER));
    error(
        response,
        StatusCode::TOO_MANY_REQUESTS,
        "too many sign-in attempts",
    )
    .await;
}

#[fukulow_test::test]
async fn full_email_budget_rejects_sign_ins_before_db_and_password_change_before_lock(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let workers = Box::leak(Box::new(PasswordWorkers::new()));
    let queue_capacity = workers.waiting.available_permits();
    let app = app_with_workers(f.state.clone(), workers);
    let mut observer = PgConnection::connect_with(&pool.connect_options())
        .await
        .unwrap();

    // Freeze the admission deadline and the budget window while the gate is held.
    tokio::time::pause();
    without_time_advance(async {
        let wrong = WrongPasswords::start(&app, workers, EMAIL_BUDGET).await;
        wait_for_backends(&mut observer, (3, 0)).await;
        while workers.waiting.available_permits() + 1 != queue_capacity {
            tokio::task::yield_now().await;
        }
        assert_eq!(f.state.sign_in_throttle.pending_counts(), (5, 5));
        assert_eq!(connections_in_use(&f.state.pool), 4);

        let ((), sign_in_acquires) = crate::database::test_acquisitions(async {
            let excess = (EMAIL_BUDGET + 2)..=(EMAIL_BUDGET + 5);
            for response in
                futures_util::future::join_all(excess.map(|ip| wrong_sign_in(&app, ip))).await
            {
                throttle_error(response).await;
            }
            throttle_error(owner_sign_in(&app, PASSWORD).await).await;
        })
        .await;
        assert_eq!(sign_in_acquires, 0);

        let ((response, peak), change_acquires) = crate::database::test_acquisitions(
            sample_pool_peak(&f.state.pool, owner_changes_password(&app, &f.current)),
        )
        .await;
        throttle_error(response).await;
        assert_eq!(change_acquires, 2);
        assert_eq!(peak, 5);
        assert_eq!(account_waiters(&mut observer).await, (3, 0));
        eprintln!(
            "Full email budget: 3 Account waiters, 4 held connections, sampled pool peak {peak}"
        );

        wrong.finish().await;
        assert_eq!(f.state.sign_in_throttle.pending_counts(), (0, 0));
        assert_eq!(account_waiters(&mut observer).await, (0, 0));
        throttle_error(owner_sign_in(&app, PASSWORD).await).await;
        throttle_error(owner_changes_password(&app, &f.current).await).await;

        tokio::time::advance(Duration::from_secs(60)).await;
        assert_eq!(owner_sign_in(&app, PASSWORD).await.status(), StatusCode::OK);
        assert_eq!(
            owner_changes_password(&app, &f.current).await.status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            owner_sign_in(&app, NEW_PASSWORD).await.status(),
            StatusCode::OK
        );
    })
    .await;
    tokio::time::resume();
}

async fn owner_waits_for_wrong_passwords(
    pool_options: PgPoolOptions,
    connect_options: PgConnectOptions,
    change_password: bool,
) {
    const IN_FLIGHT_ATTEMPTS: u8 = 3;
    let bound = usize::from(IN_FLIGHT_ATTEMPTS) + 1 + 1; // Owner operation and slack.
    // Leave room for the pool to exceed B3 so its cap cannot mask a regression.
    let pool = pool_options
        .max_connections(6)
        .connect_with(connect_options)
        .await
        .unwrap();
    let f = fixture(&pool).await;
    let workers = Box::leak(Box::new(PasswordWorkers::new()));
    let app = app_with_workers(f.state.clone(), workers);
    let mut observer = PgConnection::connect_with(&pool.connect_options())
        .await
        .unwrap();

    tokio::time::pause();
    let expected = if change_password { (2, 1) } else { (3, 0) };
    without_time_advance(async {
        // The watchdog keeps polling the sampler during the detached password change.
        let (response, peak) = sample_pool_peak(&f.state.pool, async {
            let wrong = WrongPasswords::start(&app, workers, IN_FLIGHT_ATTEMPTS).await;
            wait_for_backends(&mut observer, (2, 0)).await;
            let owner = tokio::spawn({
                let app = app.clone();
                let token = f.current.clone();
                async move {
                    if change_password {
                        owner_changes_password(&app, &token).await
                    } else {
                        owner_sign_in(&app, PASSWORD).await
                    }
                }
            });
            wait_for_backends(&mut observer, expected).await;
            assert_eq!(connections_in_use(&f.state.pool), 4);
            assert!(!owner.is_finished());

            wrong.finish().await;
            owner.await.unwrap()
        })
        .await;
        let pool_max = f.state.pool.options().get_max_connections() as usize;
        assert!(peak <= bound, "sampled pool peak {peak} exceeds B3 bound {bound}");
        assert!(peak < pool_max, "sampled pool peak {peak} reached pool maximum {pool_max}");
        let expected_peak = if change_password { 5 } else { 4 };
        assert_eq!(peak, expected_peak, "sampled pool peak");

        let (status, password) = if change_password {
            (StatusCode::NO_CONTENT, NEW_PASSWORD)
        } else {
            (StatusCode::OK, PASSWORD)
        };
        assert_eq!(response.status(), status);
        eprintln!("Owner admitted: Account waiters {expected:?} (sign-in, password change), 4 held connections, sampled pool peak {peak} (B3 bound {bound}, pool maximum {pool_max})");
        assert_eq!(f.state.sign_in_throttle.pending_counts(), (0, 0));
        assert_eq!(account_waiters(&mut observer).await, (0, 0));
        assert_eq!(owner_sign_in(&app, password).await.status(), StatusCode::OK);
    })
    .await;
    tokio::time::resume();
    pool.close().await;
}

#[fukulow_test::test]
async fn admitted_owner_sign_in_waits_behind_wrong_passwords(
    pool_options: PgPoolOptions,
    connect_options: PgConnectOptions,
) {
    owner_waits_for_wrong_passwords(pool_options, connect_options, false).await;
}

#[fukulow_test::test]
async fn admitted_owner_password_change_waits_behind_wrong_passwords(
    pool_options: PgPoolOptions,
    connect_options: PgConnectOptions,
) {
    owner_waits_for_wrong_passwords(pool_options, connect_options, true).await;
}
