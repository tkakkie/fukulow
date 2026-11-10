use std::{
    collections::HashMap,
    future::{Future, poll_fn},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    task::Poll,
};
use tokio::sync::watch;
use uuid::Uuid;

type ChannelKey = (Uuid, Uuid);

#[derive(Default)]
struct ChannelFailure {
    signal: Arc<Signal>,
    subscribers: usize,
}

#[derive(Default)]
struct Signal {
    failed: AtomicBool,
    changed: watch::Sender<bool>,
}

impl Signal {
    fn fail(self: &Arc<Self>) {
        if !self.failed.swap(true, Ordering::SeqCst) {
            let signal = self.clone();
            // watch wakes its receivers inline: keep that fan-out off the publish path.
            tokio::spawn(async move {
                signal.changed.send_replace(true);
            });
        }
    }
}

/// Separate from recipients: signalling does constant work, never inline fan-out.
#[derive(Clone, Default)]
pub(super) struct Failures(Arc<Mutex<HashMap<ChannelKey, ChannelFailure>>>);

#[derive(Clone, Default)]
pub(crate) struct FailureWatch {
    signals: Arc<Mutex<HashMap<Uuid, Arc<Signal>>>>,
    failed: Arc<AtomicBool>,
    subscriptions_changed: watch::Sender<()>,
}

impl Failures {
    pub(super) fn signal(&self, key: ChannelKey) {
        let registry = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(channel) = registry.get(&key) {
            channel.signal.fail();
        }
    }

    pub(super) fn subscribe(&self, key: ChannelKey, watch: &FailureWatch) {
        let mut registry = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let channel = registry.entry(key).or_default();
        // Old subscribers retain the latched failure; later subscribers start fresh.
        if channel.signal.failed.load(Ordering::SeqCst) {
            channel.signal = Arc::default();
        }
        channel.subscribers += 1;
        watch
            .signals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key.1, channel.signal.clone());
        watch.subscriptions_changed.send_replace(());
    }

    pub(super) fn unsubscribe(&self, key: ChannelKey, watch: &FailureWatch) {
        let mut registry = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(signal) = watch
            .signals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&key.1)
        {
            // Unsubscribe must not erase a failure that preceded it.
            if signal.failed.load(Ordering::SeqCst) {
                watch.failed.store(true, Ordering::SeqCst);
            }
            watch.subscriptions_changed.send_replace(());
            if let Some(channel) = registry.get_mut(&key) {
                channel.subscribers -= 1;
                if channel.subscribers == 0 {
                    registry.remove(&key);
                }
            }
        }
    }
}

impl FailureWatch {
    pub(crate) fn is_failed(&self) -> bool {
        self.failed.load(Ordering::SeqCst)
            || self
                .signals
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .values()
                .any(|signal| signal.failed.load(Ordering::SeqCst))
    }

    pub(crate) async fn failed(&self) {
        let mut subscriptions = self.subscriptions_changed.subscribe();
        loop {
            // Mark before snapshotting: a concurrent subscription change must either be
            // in the snapshot or wake changed(). Atomic latches cover deferred wakes.
            subscriptions.borrow_and_update();
            if self.is_failed() {
                return;
            }
            let signals: Vec<_> = self
                .signals
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .values()
                .cloned()
                .collect();
            let mut waits: Vec<_> = signals
                .iter()
                .map(|signal| {
                    let mut receiver = signal.changed.subscribe();
                    Box::pin(async move { receiver.wait_for(|failed| *failed).await.map(|_| ()) })
                })
                .collect();
            // Recheck current latches after either wake: an old epoch may have failed
            // after this socket unsubscribed, while other sockets still retained it.
            tokio::select! {
                _ = subscriptions.changed() => {},
                _ = poll_fn(|cx| {
                    for wait in &mut waits {
                        if wait.as_mut().poll(cx).is_ready() {
                            return Poll::Ready(());
                        }
                    }
                    Poll::Pending
                }) => {},
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::atomic::AtomicUsize,
        task::{Context, Wake, Waker},
        time::Duration,
    };

    #[derive(Default)]
    struct Wakes(AtomicUsize);

    impl Wake for Wakes {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn failure_wake_is_deferred_coalesced_and_timer_free() {
        let failures = Failures::default();
        let key = (Uuid::new_v4(), Uuid::new_v4());
        let watch = FailureWatch::default();
        failures.subscribe(key, &watch);
        let mut receiver = watch.signals.lock().unwrap()[&key.1].changed.subscribe();
        let wakes = Arc::new(Wakes::default());
        let waker = Waker::from(wakes.clone());
        let mut cx = Context::from_waker(&waker);
        let mut wait = Box::pin(watch.failed());
        assert!(wait.as_mut().poll(&mut cx).is_pending());
        let started = tokio::time::Instant::now();
        for _ in 0..1_000 {
            failures.signal(key);
        }
        assert!(watch.is_failed());
        assert_eq!(wakes.0.load(Ordering::SeqCst), 0, "inline wake-up");
        assert!(!receiver.has_changed().unwrap());
        tokio::time::timeout(Duration::from_secs(1), receiver.changed())
            .await
            .expect("deferred notification was lost")
            .unwrap();
        assert!(wakes.0.load(Ordering::SeqCst) > 0);
        assert!(wait.as_mut().poll(&mut cx).is_ready());
        assert_eq!(started.elapsed(), Duration::ZERO, "timer-based wake-up");
        assert!(*receiver.borrow_and_update());
        failures.signal(key);
        tokio::task::yield_now().await;
        assert!(
            !receiver.has_changed().unwrap(),
            "more than one epoch notification"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn subscription_changes_and_cancelled_waits_keep_failure_signals() {
        let failures = Failures::default();
        let key = (Uuid::new_v4(), Uuid::new_v4());
        let watch = FailureWatch::default();
        let other = FailureWatch::default();
        let mut cx = Context::from_waker(Waker::noop());
        let mut wait = Box::pin(watch.failed());
        assert!(wait.as_mut().poll(&mut cx).is_pending());
        failures.subscribe(key, &watch);
        failures.subscribe(key, &other);
        assert!(wait.as_mut().poll(&mut cx).is_pending());
        failures.unsubscribe(key, &watch);
        // Both the stale epoch wake and subscription-change wake are ready. Neither
        // may close a socket which unsubscribed before this failure.
        failures.signal(key);
        tokio::task::yield_now().await;
        assert!(wait.as_mut().poll(&mut cx).is_pending());
        failures.subscribe(key, &watch);
        assert!(wait.as_mut().poll(&mut cx).is_pending());
        // Cancellation before the deferred task runs must not consume the latch.
        failures.signal(key);
        drop(wait);
        failures.unsubscribe(key, &watch);
        failures.subscribe(key, &watch);
        observed(&watch).await;
        observed(&other).await;
        failures.unsubscribe(key, &watch);
        failures.unsubscribe(key, &other);
        assert!(failures.0.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn failure_between_subscription_change_and_wait_registration_is_latched() {
        for refresh_wait in [false, true] {
            for unsubscribe in [false, true] {
                let failures = Failures::default();
                let key = (Uuid::new_v4(), Uuid::new_v4());
                let watch = FailureWatch::default();
                let mut cx = Context::from_waker(Waker::noop());
                let mut wait = Box::pin(watch.failed());
                assert!(wait.as_mut().poll(&mut cx).is_pending());
                failures.subscribe(key, &watch);
                // Coalesce topology changes before the waiter can rebuild its snapshot.
                failures.unsubscribe(key, &watch);
                failures.subscribe(key, &watch);
                if refresh_wait {
                    assert!(wait.as_mut().poll(&mut cx).is_pending());
                }
                failures.signal(key);
                if unsubscribe {
                    failures.unsubscribe(key, &watch);
                }
                tokio::time::timeout(Duration::from_secs(1), wait)
                    .await
                    .expect("failure lost across subscription/wait registration");
            }
        }
    }

    async fn observed(watch: &FailureWatch) {
        tokio::time::timeout(Duration::from_secs(1), watch.failed())
            .await
            .expect("latched failure was lost");
    }

    #[tokio::test(start_paused = true)]
    async fn coalesced_failures_latch_all_epochs_without_closing_later_subscribers() {
        let failures = Failures::default();
        let key = (Uuid::new_v4(), Uuid::new_v4());
        let first = FailureWatch::default();
        failures.subscribe(key, &first);
        for _ in 0..1_000 {
            failures.signal(key);
        }
        let second = FailureWatch::default();
        failures.subscribe(key, &second);
        observed(&first).await;
        assert!(!second.is_failed());
        failures.signal(key);
        let third = FailureWatch::default();
        failures.subscribe(key, &third);
        // Removing/replacing a subscription before observation cannot erase failure.
        failures.unsubscribe(key, &second);
        failures.subscribe(key, &second);
        observed(&second).await;
        observed(&first).await;
        assert!(!third.is_failed());
        failures.unsubscribe(key, &first);
        failures.unsubscribe(key, &second);
        failures.unsubscribe(key, &third);
        assert!(failures.0.lock().unwrap().is_empty());
        failures.signal(key);
        let later = FailureWatch::default();
        failures.subscribe(key, &later);
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(!later.is_failed());
    }
}
