use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use uuid::Uuid;

type ChannelKey = (Uuid, Uuid);

#[derive(Default)]
struct ChannelFailure {
    signal: Arc<AtomicBool>,
    subscribers: usize,
}

/// Separate from recipients: every critical section does constant work, never fan-out.
#[derive(Clone, Default)]
pub(super) struct Failures(Arc<Mutex<HashMap<ChannelKey, ChannelFailure>>>);

#[derive(Clone, Default)]
pub(crate) struct FailureWatch {
    signals: Arc<Mutex<HashMap<Uuid, Arc<AtomicBool>>>>,
    failed: Arc<AtomicBool>,
}

impl Failures {
    pub(super) fn signal(&self, key: ChannelKey) {
        let registry = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(channel) = registry.get(&key) {
            channel.signal.store(true, Ordering::SeqCst);
        }
    }

    pub(super) fn subscribe(&self, key: ChannelKey, watch: &FailureWatch) {
        let mut registry = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let channel = registry.entry(key).or_default();
        // Old subscribers retain the latched failure; later subscribers start fresh.
        if channel.signal.load(Ordering::SeqCst) {
            channel.signal = Arc::default();
        }
        channel.subscribers += 1;
        watch
            .signals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key.1, channel.signal.clone());
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
            if signal.load(Ordering::SeqCst) {
                watch.failed.store(true, Ordering::SeqCst);
            }
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
                .any(|signal| signal.load(Ordering::SeqCst))
    }

    pub(crate) async fn failed(&self) {
        // Poll per socket, including during replay: signalling never wakes/visits subscribers
        // on the HTTP path. Each check is bounded by the socket's subscription limit (256).
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if self.is_failed() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        first.failed().await;
        assert!(!second.is_failed());
        failures.signal(key);
        let third = FailureWatch::default();
        failures.subscribe(key, &third);
        // Removing/replacing a subscription before the next poll cannot erase failure.
        failures.unsubscribe(key, &second);
        failures.subscribe(key, &second);
        second.failed().await;
        first.failed().await;
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
