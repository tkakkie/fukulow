use std::{
    collections::HashMap,
    hash::Hash,
    sync::{Arc, LazyLock, Mutex},
    time::Duration,
};
use tokio::{sync::Semaphore, time::timeout};

const ENTER_TIMEOUT: Duration = Duration::from_secs(5);
// Some tests advance virtual time while holding a gate across several deadlines.
const RELEASE_TIMEOUT: Duration = Duration::from_secs(60);

pub(crate) struct Gate<T = ()> {
    entered: Semaphore,
    pub(crate) release: Semaphore,
    pub(crate) data: T,
}

impl<T: Default> Default for Gate<T> {
    fn default() -> Self {
        Self {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            data: T::default(),
        }
    }
}

impl<T> Gate<T> {
    pub(crate) async fn entered(&self) {
        self.entered_within(ENTER_TIMEOUT).await;
    }

    pub(crate) async fn entered_within(&self, deadline: Duration) {
        timeout(deadline, self.entered.acquire())
            .await
            .unwrap_or_else(|_| panic!("test gate did not enter within {deadline:?}"))
            .unwrap()
            .forget();
    }

    pub(crate) fn pending_entries(&self) -> usize {
        self.entered.available_permits()
    }

    pub(crate) fn signal_entered(&self) {
        self.entered.add_permits(1);
    }

    pub(crate) fn release(&self) {
        self.release.add_permits(1);
    }

    pub(crate) async fn pause(&self) {
        self.signal_entered();
        timeout(RELEASE_TIMEOUT, self.release.acquire())
            .await
            .expect("test gate was not released within 60s")
            .unwrap()
            .forget();
    }
}

/// A registration is consumed by the first matching hook.
pub(crate) struct Gates<K, T = ()> {
    gates: LazyLock<Mutex<HashMap<K, Arc<Gate<T>>>>>,
}

impl<K, T> Gates<K, T> {
    pub(crate) const fn new() -> Self {
        Self {
            gates: LazyLock::new(|| Mutex::new(HashMap::new())),
        }
    }
}

impl<K, T> Default for Gates<K, T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<K: Eq + Hash, T: Default> Gates<K, T> {
    pub(crate) fn register(&self, key: K) -> Arc<Gate<T>> {
        let gate = Arc::new(Gate::default());
        self.gates.lock().unwrap().insert(key, gate.clone());
        gate
    }

    // Session hooks keep at most one pending phase per SessionChanges instance.
    pub(crate) fn register_replacing(&self, key: K) -> Arc<Gate<T>> {
        let gate = Arc::new(Gate::default());
        let mut gates = self.gates.lock().unwrap();
        gates.clear();
        gates.insert(key, gate.clone());
        gate
    }
}

impl<K: Eq + Hash, T> Gates<K, T> {
    pub(crate) fn get(&self, key: &K) -> Option<Arc<Gate<T>>> {
        self.gates.lock().unwrap().get(key).cloned()
    }

    pub(crate) fn take(&self, key: &K) -> Option<Arc<Gate<T>>> {
        self.gates.lock().unwrap().remove(key)
    }

    pub(crate) async fn pause(&self, key: K) -> bool {
        if let Some(gate) = self.take(&key) {
            gate.pause().await;
            true
        } else {
            false
        }
    }

    pub(crate) async fn pause_with_fallback(&self, key: K, fallback: K) {
        let gate = {
            let mut gates = self.gates.lock().unwrap();
            gates.remove(&key).or_else(|| gates.remove(&fallback))
        };
        if let Some(gate) = gate {
            gate.pause().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::task::{Context, Waker};

    #[tokio::test]
    async fn registered_gate_fires_once_and_waits_for_release() {
        let gates = Gates::<_>::new();
        let gate = gates.register(1);
        let mut cx = Context::from_waker(Waker::noop());
        let mut hook = std::pin::pin!(gates.pause(1));
        assert!(hook.as_mut().poll(&mut cx).is_pending());
        gate.entered().await;
        assert!(!gates.pause(1).await);
        assert!(hook.as_mut().poll(&mut cx).is_pending());
        gate.release();
        assert!(hook.await);
    }

    #[tokio::test(start_paused = true)]
    #[should_panic(expected = "test gate did not enter within 5s")]
    async fn entered_panics_when_hook_never_fires() {
        let gates = Gates::<_>::new();
        let gate = gates.register(1);
        timeout(ENTER_TIMEOUT + Duration::from_secs(1), gate.entered())
            .await
            .expect("entered() hung without its own timeout");
    }

    #[tokio::test]
    async fn registered_gates_are_isolated_by_key() {
        let gates = Gates::<_>::new();
        let first = gates.register(1);
        let second = gates.register(2);

        assert!(!gates.pause(3).await);
        assert_eq!(first.pending_entries(), 0);
        assert_eq!(second.pending_entries(), 0);

        let mut cx = Context::from_waker(Waker::noop());
        let mut hook = std::pin::pin!(gates.pause(2));
        assert!(hook.as_mut().poll(&mut cx).is_pending());
        second.entered().await;
        assert_eq!(first.pending_entries(), 0);
        assert!(Arc::ptr_eq(&gates.take(&1).unwrap(), &first));
        second.release();
        assert!(hook.await);
    }
}
