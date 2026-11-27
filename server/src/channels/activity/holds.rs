use super::*;
use crate::observability::{
    RevocationHoldCounts, RevocationMetric, RevocationMetrics, revocation_measurement_enabled,
    revocation_metrics,
};
use std::{
    collections::BTreeMap,
    sync::{LazyLock, MutexGuard, atomic::AtomicU64},
};

const REGISTRATION_CAP: usize = 64;
const GLOBAL_CAP: usize = 4096;
const TIMEOUT: Duration = Duration::from_secs(30);
const RETRIES: u32 = 5;
const BACKOFF: Duration = Duration::from_millis(250);
const MAX_BACKOFF: Duration = Duration::from_secs(4);
static CAPACITY: LazyLock<Arc<Capacity>> = LazyLock::new(|| Arc::new(Capacity::new(GLOBAL_CAP)));

type HoldKey = (Instant, Uuid, u64);

pub(super) struct Capacity {
    limit: usize,
    measure: bool,
    reservations: Mutex<Reservations>,
    retry_attempts: AtomicU64,
}

#[derive(Default)]
struct Reservations {
    owners: BTreeMap<HoldKey, Weak<Entry>>,
    high_water_mark: usize,
}

impl Capacity {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            measure: revocation_measurement_enabled(),
            reservations: Mutex::default(),
            retry_attempts: AtomicU64::new(0),
        }
    }

    fn reserve(self: &Arc<Self>, entry: &Arc<Entry>, id: u64, expires: Instant) -> Option<Permit> {
        let mut reservations = lock_ignoring_poison(&self.reservations);
        if reservations.owners.len() >= self.limit {
            return None;
        }
        let key = (expires, entry.id, id);
        reservations.owners.insert(key, Arc::downgrade(entry));
        if self.measure {
            reservations.high_water_mark =
                reservations.high_water_mark.max(reservations.owners.len());
        }
        Some(Permit {
            capacity: self.clone(),
            key,
        })
    }

    fn expired(&self, now: Instant) -> Option<(HoldKey, Weak<Entry>)> {
        let reservations = lock_ignoring_poison(&self.reservations);
        let (&key, entry) = reservations.owners.first_key_value()?;
        (key.0 <= now).then(|| (key, entry.clone()))
    }

    fn release(&self, key: HoldKey) {
        lock_ignoring_poison(&self.reservations).owners.remove(&key);
    }

    pub(super) fn count_retry_attempt(&self) {
        self.retry_attempts.fetch_add(1, Ordering::Relaxed);
    }

    fn sample(&self) -> RevocationHoldCounts {
        let reservations = lock_ignoring_poison(&self.reservations);
        RevocationHoldCounts {
            active_holds: reservations.owners.len(),
            high_water_mark: reservations.high_water_mark,
            retry_attempts: self.retry_attempts.load(Ordering::Relaxed),
        }
    }

    #[cfg(test)]
    fn available_permits(&self) -> usize {
        self.limit - self.reservations.lock().unwrap().owners.len()
    }
}

pub(crate) fn revocation_hold_counts() -> RevocationHoldCounts {
    CAPACITY.sample()
}

struct Permit {
    capacity: Arc<Capacity>,
    key: HoldKey,
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.capacity.release(self.key);
    }
}

pub(super) fn lock_for_admission(entry: &Arc<Entry>) -> (MutexGuard<'_, Buffer>, Instant) {
    loop {
        let mut b = lock_ignoring_poison(&entry.buffer);
        let now = Instant::now();
        let Buffer {
            holds, revocations, ..
        } = &mut *b;
        holds.prune(revocations, now);
        let Some((key, owner)) = holds.capacity.expired(now) else {
            return (b, now);
        };
        let capacity = holds.capacity.clone();
        // Replay can keep the owner from polling its buffer. Prune there before
        // admitting more holds, without nesting buffer locks or holding the index lock.
        drop(b);
        if let Some(owner) = owner.upgrade() {
            let mut b = lock_ignoring_poison(&owner.buffer);
            let Buffer {
                holds, revocations, ..
            } = &mut *b;
            holds.prune(revocations, now);
        } else {
            capacity.release(key);
        }
    }
}

struct Hold {
    _permit: Permit,
    expires: Instant,
    retry_at: Instant,
    retries: u32,
    parked: Option<Pending>,
}

pub(super) struct Holds {
    entries: BTreeMap<u64, Box<Hold>>,
    capacity: Arc<Capacity>,
    metrics: Arc<RevocationMetrics>,
    closed: bool,
}

impl Default for Holds {
    fn default() -> Self {
        Self {
            entries: BTreeMap::new(),
            capacity: CAPACITY.clone(),
            metrics: revocation_metrics(),
            closed: false,
        }
    }
}

impl Holds {
    #[cfg(test)]
    pub(super) fn isolate_metrics(&mut self) -> Arc<RevocationMetrics> {
        self.metrics = Arc::default();
        self.metrics.clone()
    }

    pub(super) fn start(
        &mut self,
        entry: &Arc<Entry>,
        revocations: &Revocations,
        id: u64,
        now: Instant,
    ) {
        if self.closed || revocations.check(id).is_none() {
            return;
        }
        // Invalidate even an in-flight retry's snapshot if a later query fails.
        revocations.invalidate(id);
        if self.entries.contains_key(&id) {
            return;
        }
        if self.entries.len() >= REGISTRATION_CAP {
            self.metrics.count(RevocationMetric::RegistrationCap);
        } else if let Some(permit) = self.capacity.reserve(entry, id, now + TIMEOUT) {
            self.entries.insert(
                id,
                Box::new(Hold {
                    _permit: permit,
                    expires: now + TIMEOUT,
                    retry_at: now + BACKOFF,
                    retries: 0,
                    parked: None,
                }),
            );
            self.metrics.count(RevocationMetric::Held);
            return;
        } else {
            self.metrics.count(RevocationMetric::GlobalCap);
        }
        revocations.finish(id);
    }

    pub(super) fn deadline(&self, id: u64) -> Option<Instant> {
        self.entries.get(&id).map(|hold| hold.expires)
    }

    pub(super) fn retry_measurement(&self) -> Option<Arc<Capacity>> {
        self.capacity.measure.then(|| self.capacity.clone())
    }

    pub(super) fn park(&mut self, id: u64, pending: impl FnOnce() -> Pending) {
        if let Some(hold) = self.entries.get_mut(&id) {
            hold.parked = Some(pending());
        }
    }

    pub(super) fn due(&mut self, now: Instant) -> (Option<Pending>, Option<Instant>) {
        let mut next = None;
        for hold in self.entries.values_mut() {
            let wake = if hold.parked.is_some() {
                if hold.retry_at <= now {
                    hold.retries += 1;
                    return (hold.parked.take(), None);
                }
                hold.retry_at.min(hold.expires)
            } else {
                hold.expires
            };
            next = Some(next.map_or(wake, |earliest: Instant| earliest.min(wake)));
        }
        (None, next)
    }

    pub(super) fn retry_failed(
        &mut self,
        revocations: &Revocations,
        id: u64,
        pending: Pending,
        now: Instant,
    ) {
        let Some(hold) = self.entries.get_mut(&id) else {
            return;
        };
        if hold.retries >= RETRIES {
            self.finish(revocations, id, RevocationMetric::Retries);
        } else {
            revocations.invalidate(id);
            hold.retry_at = now + (BACKOFF * (1 << hold.retries)).min(MAX_BACKOFF);
            hold.parked = Some(pending);
        }
    }

    pub(super) fn complete(&mut self, id: u64, delivered_revocation: bool) {
        if self.entries.remove(&id).is_some() && delivered_revocation {
            self.metrics.count(RevocationMetric::Delivered);
        }
    }

    pub(super) fn prune(&mut self, revocations: &Revocations, now: Instant) {
        self.entries.retain(|&id, hold| {
            let reason = if revocations.check(id).is_none() {
                RevocationMetric::Fenced
            } else if now >= hold.expires {
                RevocationMetric::Timeout
            } else {
                return true;
            };
            self.metrics.count(reason);
            revocations.finish(id);
            false
        });
    }

    fn finish(&mut self, revocations: &Revocations, id: u64, reason: RevocationMetric) {
        revocations.finish(id);
        self.entries.remove(&id);
        self.metrics.count(reason);
    }

    pub(super) fn close(&mut self, revocations: &Revocations) {
        self.closed = true;
        while let Some(id) = self.entries.keys().next().copied() {
            self.finish(revocations, id, RevocationMetric::Fenced);
        }
    }

    pub(super) fn recheck_error(&self) {
        self.metrics.count(RevocationMetric::RecheckError);
    }
}

#[cfg(test)]
mod tests;
