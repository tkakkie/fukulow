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

#[tokio::test(start_paused = true)]
#[should_panic(expected = "default fatal hook called; use with_on_fatal")]
async fn forgotten_fatal_override_is_detected_in_test_task() {
    let changes = SessionChanges::default();
    let (_, _, pool) = fixture();
    let worker = tokio::spawn(async {});
    let supervisor = tokio::spawn(supervise(
        worker,
        Arc::downgrade(&changes.sessions),
        pool,
        changes.on_fatal.clone(),
    ));
    supervisor.await.unwrap();
    // The default returned safely in the background; detection fails this test task.
    assert_eq!(
        changes
            .default_fatal_calls
            .as_ref()
            .unwrap()
            .load(Ordering::SeqCst),
        1
    );
    SessionChanges::default().assert_no_default_fatal();
    changes.assert_no_default_fatal();
}

#[tokio::test]
#[should_panic(expected = "worker panic tests must call with_on_fatal")]
async fn worker_panic_helper_rejects_forgotten_fatal_override() {
    SessionChanges::default().panic_worker().await;
}

#[tokio::test(start_paused = true)]
async fn worker_panic_requests_fatal_exit_once_after_grace() {
    assert_eq!(EXIT_GRACE, Duration::from_secs(2));
    let (changes, calls, pool) = fixture();
    changes.start_rechecks(&pool);
    changes.panic_worker().await;
    assert!(changes.sessions.lock().unwrap().unavailable);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let mut refused = SessionWatch {
        registration: changes.register((Uuid::new_v4(), vec![])),
        deadline: Some(Instant::now() + Duration::from_secs(60)),
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
async fn join_errors_never_become_normal_during_shutdown() {
    for panic in [false, true] {
        for registry_dropped in [false, true] {
            for pool_closed in [false, true] {
                let (changes, calls, pool) = fixture();
                let sessions = Arc::downgrade(&changes.sessions);
                let on_fatal = changes.on_fatal.clone();
                let worker = tokio::spawn(async move {
                    if panic {
                        panic!("injected worker panic");
                    }
                    std::future::pending::<()>().await;
                });
                if !panic {
                    worker.abort();
                }
                if pool_closed {
                    pool.close().await;
                }
                if registry_dropped {
                    drop(changes);
                    assert!(sessions.upgrade().is_none());
                }
                let supervisor = tokio::spawn(supervise(worker, sessions, pool, on_fatal));
                supervisor.await.unwrap();
                assert_eq!(calls.load(Ordering::SeqCst), 1);
            }
        }
    }
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
        changes.subscriptions.clone(),
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
