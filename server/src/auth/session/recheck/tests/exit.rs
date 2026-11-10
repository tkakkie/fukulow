use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

fn fixture() -> (SessionChanges, Arc<AtomicUsize>, PgPool) {
    let calls = Arc::new(AtomicUsize::new(0));
    let recorder = calls.clone();
    let changes = SessionChanges::default().with_on_fatal(Arc::new(move || {
        recorder.fetch_add(1, Ordering::SeqCst);
    }));
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1/unused")
        .unwrap();
    (changes, calls, pool)
}

#[test]
fn production_fatal_hook_exits_with_code_one() {
    assert!(std::ptr::fn_addr_eq(
        FATAL_EXIT.0,
        std::process::exit as fn(i32) -> !,
    ));
    assert_eq!(FATAL_EXIT.1, 1);
    assert_eq!(EXIT_GRACE, Duration::from_secs(2));
}

#[tokio::test(start_paused = true)]
async fn worker_panic_requests_fatal_exit_once_after_grace() {
    let (changes, calls, pool) = fixture();
    changes.start_rechecks(&pool);
    changes.panic_worker().await;
    assert!(changes.sessions.lock().unwrap().unavailable);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let mut refused = SessionWatch {
        registration: changes.register((Uuid::new_v4(), vec![])),
        deadline: Instant::now() + Duration::from_secs(60),
    };
    assert!(refused.ended().await.is_err());
    tokio::time::advance(EXIT_GRACE - Duration::from_millis(1)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    tokio::time::advance(Duration::from_millis(1)).await;
    tokio::task::yield_now().await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    changes.start_rechecks(&pool);
    tokio::time::advance(RECHECK_INTERVAL + EXIT_GRACE).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn cancelled_or_returned_worker_requests_fatal_exit_after_grace() {
    for cancelled in [false, true] {
        let (changes, calls, pool) = fixture();
        let mut registration = changes.register((Uuid::new_v4(), vec![]));
        let worker = tokio::spawn(async move {
            if cancelled {
                std::future::pending::<()>().await;
            }
        });
        if cancelled {
            worker.abort();
        }
        let supervisor = tokio::spawn(supervise(
            worker,
            Arc::downgrade(&changes.sessions),
            pool,
            changes.on_fatal.clone(),
        ));
        registration.changed.wait_for(|s| s.failed).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        tokio::time::advance(EXIT_GRACE - Duration::from_millis(1)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        tokio::time::advance(Duration::from_millis(1)).await;
        supervisor.await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test(start_paused = true)]
async fn pool_shutdown_never_requests_fatal_exit() {
    let (changes, calls, pool) = fixture();
    let mut registration = changes.register((Uuid::new_v4(), vec![]));
    changes.start_rechecks(&pool);
    pool.close().await;
    registration.changed.wait_for(|s| s.failed).await.unwrap();
    assert!(changes.sessions.lock().unwrap().unavailable);
    tokio::time::advance(RECHECK_INTERVAL + EXIT_GRACE).await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn registry_drop_never_requests_fatal_exit() {
    let (changes, calls, pool) = fixture();
    let sessions = Arc::downgrade(&changes.sessions);
    let worker = tokio::spawn(run(
        sessions.clone(),
        pool.clone(),
        RECHECK_INTERVAL,
        CHECK_TIMEOUT,
        changes.gate.clone(),
    ));
    let supervisor = tokio::spawn(supervise(
        worker,
        sessions.clone(),
        pool,
        changes.on_fatal.clone(),
    ));
    drop(changes);
    assert!(sessions.upgrade().is_none());
    supervisor.await.unwrap();
    tokio::time::advance(EXIT_GRACE).await;
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn not_started_or_running_worker_never_requests_fatal_exit() {
    let (changes, calls, pool) = fixture();
    tokio::time::advance(RECHECK_INTERVAL + EXIT_GRACE).await;
    assert!(!changes.worker.is_completed());
    assert!(!changes.sessions.lock().unwrap().unavailable);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    changes.start_rechecks(&pool);
    tokio::task::yield_now().await;
    tokio::time::advance(RECHECK_INTERVAL + EXIT_GRACE).await;
    assert!(changes.worker.is_completed());
    assert!(!changes.sessions.lock().unwrap().unavailable);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
