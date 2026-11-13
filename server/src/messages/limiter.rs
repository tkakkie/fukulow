//! Per-(Organization, Member) send limiter and bounded duplicate tracking (#306).
//! State is in-process and bounded; numbers and memory estimates are in
//! `docs/decisions/messages.md`.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use tokio::sync::watch;
use uuid::Uuid;

/// Burst capacity and initial balance, in tokens.
pub(crate) const BURST: u64 = 10;
/// One token per second, kept in milli-tokens refilled per millisecond.
const MILLIS_PER_TOKEN: u64 = 1000;
pub(crate) const MAX_BUCKETS: usize = 100_000;
pub(crate) const MAX_PENDING: usize = 10_000;
pub(crate) const MAX_WAITERS: usize = 16;
pub(crate) const UNKNOWN_TTL: Duration = Duration::from_secs(120);

/// (Organization, Member).
type Sender = (Uuid, Uuid);
/// (Organization, Member, client_message_id).
pub(crate) type Key = (Uuid, Uuid, Uuid);

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// Over the limit: whole seconds until the next token, at least 1.
    Throttled(u64),
    /// A tracking cap was reached: 503 with `Retry-After: 1`, nothing charged.
    Saturated,
}

struct Bucket {
    /// Milli-tokens at `at`.
    level: u64,
    at: Instant,
}

impl Bucket {
    fn refill(&mut self, now: Instant) {
        let elapsed = now.saturating_duration_since(self.at).as_millis();
        let gained = u64::try_from(elapsed).unwrap_or(u64::MAX);
        self.level = self
            .level
            .saturating_add(gained)
            .min(BURST * MILLIS_PER_TOKEN);
        self.at += Duration::from_millis(gained.min(BURST * MILLIS_PER_TOKEN));
        if self.level == BURST * MILLIS_PER_TOKEN {
            self.at = now;
        }
    }

    fn full(&mut self, now: Instant) -> bool {
        self.refill(now);
        self.level == BURST * MILLIS_PER_TOKEN
    }
}

enum Pending {
    /// Followers subscribe; dropping the sender wakes them.
    InFlight(watch::Sender<()>),
    /// The outcome of a COMMIT is unknown: one free retry until the deadline.
    Unknown(Instant),
}

#[derive(Default)]
struct Inner {
    buckets: HashMap<Sender, Bucket>,
    pending: HashMap<Key, Pending>,
}

#[derive(Clone, Default)]
pub(crate) struct SendLimiter {
    inner: Arc<Mutex<Inner>>,
    #[cfg(test)]
    test: Arc<Mutex<TestControl>>,
}

/// Tests use a fake clock that moves only by `advance`, and charge only when a
/// test enforces the limit, so unrelated send tests are not throttled.
#[cfg(test)]
struct TestControl {
    now: Instant,
    enforced: bool,
}

#[cfg(test)]
impl Default for TestControl {
    fn default() -> Self {
        Self {
            now: Instant::now(),
            enforced: false,
        }
    }
}

pub(crate) enum Begin {
    /// This request executes the send for its key.
    Leader(Lead),
    /// An identical request is in flight: wait for it to settle, then begin again.
    Wait(watch::Receiver<()>),
}

impl SendLimiter {
    fn now(&self) -> Instant {
        #[cfg(test)]
        return self.test.lock().unwrap_or_else(|e| e.into_inner()).now;
        #[cfg(not(test))]
        Instant::now()
    }

    #[cfg(test)]
    pub(crate) fn advance(&self, by: Duration) {
        self.test.lock().unwrap().now += by;
    }

    #[cfg(test)]
    pub(crate) fn enforce(&self) -> &Self {
        self.test.lock().unwrap().enforced = true;
        self
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // The state stays consistent at every await-free step; a panic elsewhere
        // must not disable sending.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Claims `key` or joins the identical request already in flight. Charges nothing.
    pub(crate) fn begin(&self, key: Key) -> Result<Begin, Refusal> {
        let now = self.now();
        let mut inner = self.lock();
        let free = match inner.pending.get(&key) {
            Some(Pending::InFlight(sender)) => {
                if sender.receiver_count() >= MAX_WAITERS {
                    return Err(Refusal::Saturated);
                }
                return Ok(Begin::Wait(sender.subscribe()));
            }
            Some(Pending::Unknown(until)) => *until > now,
            None => false,
        };
        if !inner.pending.contains_key(&key) && inner.pending.len() >= MAX_PENDING {
            inner
                .pending
                .retain(|_, pending| !matches!(pending, Pending::Unknown(until) if *until <= now));
            if inner.pending.len() >= MAX_PENDING {
                return Err(Refusal::Saturated);
            }
        }
        inner
            .pending
            .insert(key, Pending::InFlight(watch::channel(()).0));
        Ok(Begin::Leader(Lead {
            limiter: self.clone(),
            key,
            free,
            executing: false,
            settled: false,
        }))
    }

    fn charge(&self, sender: Sender) -> Result<(), Refusal> {
        #[cfg(test)]
        if !self.test.lock().unwrap().enforced {
            return Ok(());
        }
        let now = self.now();
        let mut inner = self.lock();
        if !inner.buckets.contains_key(&sender) && inner.buckets.len() >= MAX_BUCKETS {
            // Only a full bucket equals a fresh one, so only those are reclaimed.
            inner.buckets.retain(|_, bucket| !bucket.full(now));
            if inner.buckets.len() >= MAX_BUCKETS {
                return Err(Refusal::Saturated);
            }
        }
        let bucket = inner.buckets.entry(sender).or_insert(Bucket {
            level: BURST * MILLIS_PER_TOKEN,
            at: now,
        });
        bucket.refill(now);
        if bucket.level < MILLIS_PER_TOKEN {
            return Err(Refusal::Throttled(
                (MILLIS_PER_TOKEN - bucket.level).div_ceil(1000).max(1),
            ));
        }
        bucket.level -= MILLIS_PER_TOKEN;
        Ok(())
    }

    fn settle(&self, key: Key, unknown: bool) {
        let mut inner = self.lock();
        if unknown {
            let until = self.now() + UNKNOWN_TTL;
            inner.pending.insert(key, Pending::Unknown(until));
        } else {
            inner.pending.remove(&key);
        }
    }

    #[cfg(test)]
    pub(crate) fn pending(&self) -> usize {
        self.lock().pending.len()
    }

    #[cfg(test)]
    pub(crate) fn buckets(&self) -> usize {
        self.lock().buckets.len()
    }
}

/// The request that executes a send. Dropped unsettled: before execution nothing
/// ran (the key is released); during execution the outcome is unknown.
pub(crate) struct Lead {
    limiter: SendLimiter,
    key: Key,
    free: bool,
    executing: bool,
    settled: bool,
}

impl Lead {
    /// Charges one token unless this is the free retry of an unknown COMMIT.
    pub(crate) fn charge(&mut self) -> Result<(), Refusal> {
        if self.free {
            return Ok(());
        }
        self.limiter.charge((self.key.0, self.key.1))?;
        // A charged execution is never charged again for the same outcome.
        self.free = true;
        Ok(())
    }

    pub(crate) fn executing(&mut self) {
        self.executing = true;
    }

    /// `unknown`: the COMMIT may have happened, so a retry within the TTL is free.
    pub(crate) fn settle(mut self, unknown: bool) {
        self.settled = true;
        self.limiter.settle(self.key, unknown);
    }
}

impl Drop for Lead {
    fn drop(&mut self) {
        if !self.settled {
            self.limiter.settle(self.key, self.executing);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> Key {
        (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4())
    }

    fn lead(limiter: &SendLimiter, key: Key) -> Lead {
        match limiter.begin(key).unwrap() {
            Begin::Leader(lead) => lead,
            Begin::Wait(_) => panic!("expected leader"),
        }
    }

    fn limiter() -> SendLimiter {
        let limiter = SendLimiter::default();
        limiter.enforce();
        limiter
    }

    fn send(limiter: &SendLimiter, sender: Sender) -> Result<(), Refusal> {
        let mut lead = lead(limiter, (sender.0, sender.1, Uuid::new_v4()));
        let result = lead.charge();
        lead.settle(false);
        result
    }

    #[test]
    fn exhaustion_and_refill_follow_the_fake_clock() {
        let limiter = limiter();
        let sender = (Uuid::new_v4(), Uuid::new_v4());
        for _ in 0..BURST {
            send(&limiter, sender).unwrap();
        }
        assert_eq!(send(&limiter, sender), Err(Refusal::Throttled(1)));
        limiter.advance(Duration::from_millis(999));
        assert_eq!(send(&limiter, sender), Err(Refusal::Throttled(1)));
        limiter.advance(Duration::from_millis(1));
        send(&limiter, sender).unwrap();
        assert_eq!(send(&limiter, sender), Err(Refusal::Throttled(1)));
        // Refill is capped at the burst.
        limiter.advance(Duration::from_secs(60));
        for _ in 0..BURST {
            send(&limiter, sender).unwrap();
        }
        assert!(send(&limiter, sender).is_err());
    }

    #[test]
    fn budgets_are_per_member_and_per_organization() {
        let limiter = limiter();
        let (organization, member) = (Uuid::new_v4(), Uuid::new_v4());
        for _ in 0..BURST {
            send(&limiter, (organization, member)).unwrap();
        }
        assert!(send(&limiter, (organization, member)).is_err());
        send(&limiter, (organization, Uuid::new_v4())).unwrap();
        send(&limiter, (Uuid::new_v4(), member)).unwrap();
    }

    #[test]
    fn identical_in_flight_requests_wait_and_the_waiter_cap_refuses() {
        let limiter = limiter();
        let key = key();
        let leader = lead(&limiter, key);
        let mut waiters = Vec::new();
        for _ in 0..MAX_WAITERS {
            match limiter.begin(key).unwrap() {
                Begin::Wait(receiver) => waiters.push(receiver),
                Begin::Leader(_) => panic!("expected waiter"),
            }
        }
        assert!(matches!(limiter.begin(key), Err(Refusal::Saturated)));
        drop(waiters.pop());
        assert!(matches!(limiter.begin(key), Ok(Begin::Wait(_))));
        leader.settle(false);
        assert!(waiters.iter_mut().all(|w| w.has_changed().is_err()));
        assert_eq!(limiter.pending(), 0);
    }

    #[test]
    fn unknown_commit_gives_one_free_retry_until_the_deadline() {
        let limiter = limiter();
        let key = key();
        let sender = (key.0, key.1);
        let mut first = lead(&limiter, key);
        first.charge().unwrap();
        first.executing();
        drop(first);
        for _ in 1..BURST {
            send(&limiter, sender).unwrap();
        }
        // Empty bucket, but the retry of an unknown COMMIT is free.
        let mut retry = lead(&limiter, key);
        retry.charge().unwrap();
        // A confirmed failure clears the marker: the next attempt pays.
        retry.settle(false);
        assert_eq!(lead(&limiter, key).charge(), Err(Refusal::Throttled(1)));
        lead(&limiter, key).settle(true);
        assert!(lead(&limiter, key).free);
        lead(&limiter, key).settle(true);
        limiter.advance(UNKNOWN_TTL);
        assert!(!lead(&limiter, key).free);
    }

    #[test]
    fn dropping_before_execution_releases_the_key_without_a_marker() {
        let limiter = limiter();
        let key = key();
        let mut lead = lead(&limiter, key);
        lead.charge().unwrap();
        drop(lead);
        assert_eq!(limiter.pending(), 0);
    }

    #[test]
    fn pending_cap_refuses_new_keys_without_dropping_entries() {
        let limiter = limiter();
        let leads: Vec<_> = (0..MAX_PENDING).map(|_| lead(&limiter, key())).collect();
        assert!(matches!(limiter.begin(key()), Err(Refusal::Saturated)));
        assert_eq!(limiter.pending(), MAX_PENDING);
        drop(leads);
        assert!(matches!(limiter.begin(key()), Ok(Begin::Leader(_))));
    }

    #[test]
    fn expired_unknown_markers_are_reclaimed_at_the_pending_cap() {
        let limiter = limiter();
        for _ in 0..MAX_PENDING {
            let mut lead = lead(&limiter, key());
            lead.executing();
        }
        assert!(matches!(limiter.begin(key()), Err(Refusal::Saturated)));
        limiter.advance(UNKNOWN_TTL);
        assert!(matches!(limiter.begin(key()), Ok(Begin::Leader(_))));
    }

    #[test]
    fn bucket_cap_reclaims_only_full_buckets_and_otherwise_fails_closed() {
        let limiter = limiter();
        let organization = Uuid::new_v4();
        let members: Vec<_> = (0..MAX_BUCKETS).map(|_| Uuid::new_v4()).collect();
        for member in &members {
            send(&limiter, (organization, *member)).unwrap();
        }
        assert_eq!(
            send(&limiter, (organization, Uuid::new_v4())),
            Err(Refusal::Saturated)
        );
        assert_eq!(limiter.buckets(), MAX_BUCKETS);
        // A partly used bucket keeps its debt.
        for _ in 1..BURST {
            send(&limiter, (organization, members[0])).unwrap();
        }
        assert!(send(&limiter, (organization, members[0])).is_err());
        limiter.advance(Duration::from_secs(1));
        // Every other bucket is full again and reclaimable; members[0] is not.
        send(&limiter, (organization, Uuid::new_v4())).unwrap();
        assert_eq!(limiter.buckets(), 2);
        send(&limiter, (organization, members[0])).unwrap();
        assert!(send(&limiter, (organization, members[0])).is_err());
    }
}
