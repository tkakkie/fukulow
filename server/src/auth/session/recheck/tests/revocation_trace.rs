use super::*;
use crate::observability::{self, revocation_trace::test_worker, tests::Capture};
use sqlx::postgres::PgPoolOptions;
use std::{
    io::{self, Write},
    sync::mpsc,
};

struct StalledSink {
    capture: Capture,
    entered: Option<tokio::sync::oneshot::Sender<()>>,
    release: mpsc::Receiver<()>,
}

impl Write for StalledSink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if let Some(entered) = self.entered.take() {
            entered.send(()).unwrap();
            self.release.recv_timeout(Duration::from_secs(10)).unwrap();
        }
        self.capture.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.capture.flush()
    }
}

struct ReportCheck(tokio::sync::Semaphore);

impl SubscriptionRecheck for ReportCheck {
    fn check<'a>(
        &'a self,
        _: &'a PgPool,
        scope: SubscriptionScope,
    ) -> std::pin::Pin<Box<dyn Future<Output = Result<(), sqlx::Error>> + Send + 'a>> {
        Box::pin(async move {
            assert!(matches!(scope, SubscriptionScope::All));
            observability::database_failure(&sqlx::Error::PoolClosed);
            tracing::trace!(target: observability::REVOCATION_MEASUREMENT_TARGET, parent: None,
                event = "channel_access_revoked_sent");
            self.0.add_permits(1);
            Ok(())
        })
    }

    fn failed(&self, _: SubscriptionScope) {
        panic!("the subscription check succeeded");
    }
}

#[tokio::test]
async fn stalled_trace_sink_does_not_block_worker_or_existing_logs() {
    use tracing::instrument::WithSubscriber;
    let logs = Capture::default();
    let trace = Capture::default();
    let (started, entered) = tokio::sync::oneshot::channel();
    let (release, wait) = mpsc::channel();
    let (measurement, drain) = test_worker(
        StalledSink {
            capture: trace.clone(),
            entered: Some(started),
            release: wait,
        },
        true,
    );
    let changes = SessionChanges::default();
    let check = Arc::new(ReportCheck(tokio::sync::Semaphore::new(0)));
    changes.set_subscription_recheck(check.clone());
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1/unused")
        .unwrap();
    let task = tokio::spawn(
        run(
            Arc::downgrade(&changes.sessions),
            pool.clone(),
            Duration::from_millis(5),
            CHECK_TIMEOUT,
            changes.subscriptions.clone(),
            Some(measurement),
            changes.gate.clone(),
        )
        .with_subscriber(logs.measurement_subscriber()),
    );
    tokio::time::timeout(Duration::from_secs(3), async {
        entered.await.unwrap();
        check.0.acquire_many(12).await.unwrap().forget();
        pool.close().await;
        task.await.unwrap();
    })
    .await
    .unwrap();
    assert!(trace.text().is_empty());
    let events = logs.events();
    for name in ["database_failure", "channel_access_revoked_sent"] {
        assert!(
            events
                .iter()
                .filter(|e| e["fields"]["event"] == name)
                .count()
                >= 12
        );
    }
    assert!(!logs.text().contains("subscription_fallback_"));
    release.send(()).unwrap();
    drain().unwrap();
    let events = trace.events();
    let watermark = &events.last().unwrap()["fields"];
    assert_eq!(watermark["event"], "revocation_trace_watermark");
    assert!(watermark["dropped"].as_u64().unwrap() > 0);
    assert_eq!(watermark["attempted"], watermark["timing_attempted"]);
}

#[fukulow_test::test]
async fn one_s1_for_a_worker_tick_with_more_than_one_thousand_sessions(pool: PgPool) {
    use crate::test_support::TestPools;
    let pools = TestPools::new(pool).await;
    let (_, auth) = fixture(&pools.admin).await;
    let changes = SessionChanges::default();
    let check = Arc::new(ReportCheck(tokio::sync::Semaphore::new(0)));
    changes.set_subscription_recheck(check.clone());
    let registrations: Vec<_> = (0..=BATCH_SIZE)
        .map(|index| {
            changes.register((
                auth.identity.organization.organization_id,
                index.to_be_bytes().to_vec(),
            ))
        })
        .collect();
    let pool = pools.app.clone();
    let output = Capture::default();
    let (measurement, drain) = test_worker(output.clone(), true);
    let started = changes.gate.register(Phase::Started);
    let interval = Duration::from_secs(60);
    let task = tokio::spawn(run(
        Arc::downgrade(&changes.sessions),
        pool.clone(),
        interval,
        CHECK_TIMEOUT,
        changes.subscriptions.clone(),
        Some(measurement),
        changes.gate.clone(),
    ));
    started.entered().await;
    tokio::time::pause();
    tokio::time::advance(interval).await;
    tokio::time::resume();
    started.release();
    tokio::time::timeout(CHECK_TIMEOUT, check.0.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    {
        let sessions = changes.sessions.lock().unwrap();
        assert_eq!(sessions.entries.len(), BATCH_SIZE + 1);
        assert!(
            sessions
                .entries
                .values()
                .all(|signal| signal.borrow().revoked)
        );
    }
    // The final pool-close iteration has no keys or trace producers.
    drop(registrations);
    drop(changes);
    pool.close().await;
    task.await.unwrap();
    drain().unwrap();
    let events = output.events();
    let passes: Vec<_> = events
        .iter()
        .filter(|e| e["fields"]["event"] == "subscription_fallback_pass")
        .collect();
    assert_eq!(passes.len(), 1);
    assert_eq!(passes[0]["fields"]["outcome"], "ok");
    assert_eq!(passes[0]["fields"]["tick"], 1);
}
