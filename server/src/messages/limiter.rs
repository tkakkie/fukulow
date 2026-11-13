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

/// Production default burst capacity and initial balance, in tokens.
pub(crate) const BURST: u64 = 10;
/// Production default refill, in tokens per second.
pub(crate) const REFILL_PER_SECOND: u64 = 1;
/// Upper bound for either setting; keeps milli-token arithmetic far from overflow.
const MAX_SETTING: u64 = 1_000_000;
/// Balances are kept in milli-tokens.
const MILLIS_PER_TOKEN: u64 = 1000;
pub(crate) const MAX_BUCKETS: usize = 100_000;
pub(crate) const MAX_PENDING: usize = 10_000;
pub(crate) const MAX_WAITERS: usize = 16;
pub(crate) const UNKNOWN_TTL: Duration = Duration::from_secs(120);

/// (Organization, Member).
type Sender = (Uuid, Uuid);
/// (Organization, Member, client_message_id).
pub(crate) type Key = (Uuid, Uuid, Uuid);

/// Bucket size and refill. Only the operator sets it (`FUKULOW_SEND_BURST`,
/// `FUKULOW_SEND_REFILL_PER_SECOND`); it changes no other limiter rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SendLimit {
    burst: u64,
    refill_per_second: u64,
}

impl Default for SendLimit {
    fn default() -> Self {
        Self {
            burst: BURST,
            refill_per_second: REFILL_PER_SECOND,
        }
    }
}

impl SendLimit {
    /// Unset values keep the default; anything else must be an integer in 1..=1,000,000.
    pub fn configured(
        burst: Option<&str>,
        refill_per_second: Option<&str>,
    ) -> Result<Self, String> {
        let setting = |value: Option<&str>, name: &str, default: u64| match value {
            None => Ok(default),
            Some(value) => value
                .parse::<u64>()
                .ok()
                .filter(|value| (1..=MAX_SETTING).contains(value))
                .ok_or_else(|| format!("{name} must be an integer from 1 to {MAX_SETTING}")),
        };
        Ok(Self {
            burst: setting(burst, "FUKULOW_SEND_BURST", BURST)?,
            refill_per_second: setting(
                refill_per_second,
                "FUKULOW_SEND_REFILL_PER_SECOND",
                REFILL_PER_SECOND,
            )?,
        })
    }

    fn capacity(self) -> u64 {
        self.burst * MILLIS_PER_TOKEN
    }
}

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
    fn refill(&mut self, now: Instant, limit: SendLimit) {
        let elapsed = now.saturating_duration_since(self.at).as_millis();
        let elapsed = u64::try_from(elapsed).unwrap_or(u64::MAX);
        // `refill_per_second` tokens per second = that many milli-tokens per millisecond.
        self.level = self
            .level
            .saturating_add(elapsed.saturating_mul(limit.refill_per_second))
            .min(limit.capacity());
        if self.level == limit.capacity() {
            self.at = now;
        } else {
            // Not full, so `elapsed` is below one burst's worth of milliseconds.
            self.at += Duration::from_millis(elapsed);
        }
    }

    fn full(&mut self, now: Instant, limit: SendLimit) -> bool {
        self.refill(now, limit);
        self.level == limit.capacity()
    }
}

/// How the request that held a key ended, as its identical waiters see it.
#[derive(Clone)]
pub(crate) enum Settled {
    InFlight,
    /// Ended before persistence started: nothing ran, so a waiter begins again.
    Released,
    /// Persistence ran: waiters settle with it (its failure, if any) and never
    /// execute or pay again.
    Executed(Option<Arc<super::MessageError>>),
}

enum Pending {
    /// Followers subscribe; the leader publishes how it settled, then drops it.
    InFlight(watch::Sender<Settled>),
    /// The outcome of a charged COMMIT is unknown: one free retry until the deadline.
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
    limit: SendLimit,
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
    /// An identical request is in flight: wait for it to settle.
    Wait(watch::Receiver<Settled>),
}

impl SendLimiter {
    pub(crate) fn new(limit: SendLimit) -> Self {
        Self {
            limit,
            ..Self::default()
        }
    }

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
        let marker = match inner.pending.get(&key) {
            Some(Pending::InFlight(sender)) => {
                if sender.receiver_count() >= MAX_WAITERS {
                    return Err(Refusal::Saturated);
                }
                return Ok(Begin::Wait(sender.subscribe()));
            }
            Some(Pending::Unknown(until)) => Some(*until).filter(|until| *until > now),
            None => None,
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
            .insert(key, Pending::InFlight(watch::channel(Settled::InFlight).0));
        Ok(Begin::Leader(Lead {
            limiter: self.clone(),
            key,
            marker,
            charged: false,
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
        let limit = self.limit;
        let mut inner = self.lock();
        if !inner.buckets.contains_key(&sender) && inner.buckets.len() >= MAX_BUCKETS {
            // Only a full bucket equals a fresh one, so only those are reclaimed.
            inner.buckets.retain(|_, bucket| !bucket.full(now, limit));
            if inner.buckets.len() >= MAX_BUCKETS {
                return Err(Refusal::Saturated);
            }
        }
        let bucket = inner.buckets.entry(sender).or_insert(Bucket {
            level: limit.capacity(),
            at: now,
        });
        bucket.refill(now, limit);
        if bucket.level < MILLIS_PER_TOKEN {
            let millis = (MILLIS_PER_TOKEN - bucket.level).div_ceil(limit.refill_per_second);
            return Err(Refusal::Throttled(millis.div_ceil(1000).max(1)));
        }
        bucket.level -= MILLIS_PER_TOKEN;
        Ok(())
    }

    /// Replaces the key's in-flight entry and wakes its waiters with `settled`.
    fn finish(&self, key: Key, next: Option<Pending>, settled: Settled) {
        let mut inner = self.lock();
        let previous = match next {
            Some(next) => inner.pending.insert(key, next),
            None => inner.pending.remove(&key),
        };
        if let Some(Pending::InFlight(sender)) = previous {
            sender.send_replace(settled);
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

/// The request that executes a send for its key.
pub(crate) struct Lead {
    limiter: SendLimiter,
    key: Key,
    /// Deadline of the unknown-COMMIT marker this request consumed, if any.
    marker: Option<Instant>,
    charged: bool,
    executing: bool,
    settled: bool,
}

impl Lead {
    /// Charges one token unless this is the free retry of an unknown COMMIT.
    pub(crate) fn charge(&mut self) -> Result<(), Refusal> {
        if self.marker.is_some() || self.charged {
            return Ok(());
        }
        self.limiter.charge((self.key.0, self.key.1))?;
        self.charged = true;
        Ok(())
    }

    pub(crate) fn executing(&mut self) {
        self.executing = true;
    }

    /// After persistence. `unknown`: the COMMIT may have happened; only a charged
    /// execution earns a free retry, so free retries cannot chain.
    pub(crate) fn settle(mut self, unknown: bool, failure: Option<super::MessageError>) {
        self.settled = true;
        let next =
            (unknown && self.charged).then(|| Pending::Unknown(self.limiter.now() + UNKNOWN_TTL));
        self.limiter
            .finish(self.key, next, Settled::Executed(failure.map(Arc::new)));
    }
}

impl Drop for Lead {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        if self.executing {
            // Dropped mid-persistence (task cancelled): the outcome is unknown.
            let next = self
                .charged
                .then(|| Pending::Unknown(self.limiter.now() + UNKNOWN_TTL));
            let failure = super::MessageError::Database(sqlx::Error::WorkerCrashed);
            self.limiter
                .finish(self.key, next, Settled::Executed(Some(Arc::new(failure))));
            return;
        }
        // Nothing ran: an unexpired free retry stays available.
        let now = self.limiter.now();
        let next = self
            .marker
            .filter(|until| *until > now)
            .map(Pending::Unknown);
        self.limiter.finish(self.key, next, Settled::Released);
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
        lead.settle(false, None);
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
        leader.settle(false, Some(super::super::MessageError::ReplyParentNotFound));
        // Waiters see the leader's execution and its failure; they never begin again.
        assert!(waiters.iter_mut().all(|w| w.has_changed().is_err()));
        assert!(waiters.iter().all(|w| matches!(
            &*w.borrow(),
            Settled::Executed(Some(failure))
                if matches!(**failure, super::super::MessageError::ReplyParentNotFound)
        )));
        assert_eq!(limiter.pending(), 0);
    }

    fn exhaust(limiter: &SendLimiter, sender: Sender) {
        while send(limiter, sender).is_ok() {}
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
        exhaust(&limiter, sender);
        // Empty bucket, but the retry of an unknown COMMIT is free.
        let mut retry = lead(&limiter, key);
        retry.charge().unwrap();
        // A confirmed failure clears the marker: the next attempt pays.
        retry.settle(false, None);
        assert_eq!(lead(&limiter, key).charge(), Err(Refusal::Throttled(1)));
        // The marker expires with its deadline.
        limiter.advance(Duration::from_secs(BURST));
        let mut paid = lead(&limiter, key);
        paid.charge().unwrap();
        paid.settle(true, None);
        limiter.advance(UNKNOWN_TTL);
        exhaust(&limiter, sender);
        assert_eq!(lead(&limiter, key).charge(), Err(Refusal::Throttled(1)));
    }

    #[test]
    fn a_free_retry_that_is_unknown_again_earns_no_further_free_retry() {
        let limiter = limiter();
        let key = key();
        let mut paid = lead(&limiter, key);
        paid.charge().unwrap();
        paid.settle(true, None);
        exhaust(&limiter, (key.0, key.1));
        let mut free = lead(&limiter, key);
        free.charge().unwrap();
        free.executing();
        free.settle(true, None);
        assert_eq!(limiter.pending(), 0);
        assert_eq!(lead(&limiter, key).charge(), Err(Refusal::Throttled(1)));
    }

    #[test]
    fn a_free_retry_dropped_before_execution_keeps_the_marker() {
        let limiter = limiter();
        let key = key();
        let mut paid = lead(&limiter, key);
        paid.charge().unwrap();
        paid.settle(true, None);
        exhaust(&limiter, (key.0, key.1));
        // Cancelled or refused by admission before persistence: still free next time.
        let mut cancelled = lead(&limiter, key);
        cancelled.charge().unwrap();
        drop(cancelled);
        assert_eq!(limiter.pending(), 1);
        let mut retry = lead(&limiter, key);
        retry.charge().unwrap();
        // An expired marker is not restored.
        limiter.advance(UNKNOWN_TTL);
        drop(retry);
        assert_eq!(limiter.pending(), 0);
    }

    #[test]
    fn dropping_before_execution_releases_the_key_and_wakes_waiters_to_begin_again() {
        let limiter = limiter();
        let key = key();
        let mut lead = lead(&limiter, key);
        let Ok(Begin::Wait(mut waiter)) = limiter.begin(key) else {
            panic!("expected waiter");
        };
        lead.charge().unwrap();
        drop(lead);
        assert_eq!(limiter.pending(), 0);
        assert!(matches!(&*waiter.borrow_and_update(), Settled::Released));
    }

    #[test]
    fn configured_limits_change_only_size_and_refill() {
        assert_eq!(SendLimit::configured(None, None), Ok(SendLimit::default()));
        for bad in ["0", "-1", "1.5", "", " 5", "abc", "1000001"] {
            assert!(SendLimit::configured(Some(bad), None).is_err(), "{bad:?}");
            assert!(SendLimit::configured(None, Some(bad)).is_err(), "{bad:?}");
        }
        let limit = SendLimit::configured(Some("3"), Some("2")).unwrap();
        let limiter = SendLimiter::new(limit);
        limiter.enforce();
        let sender = (Uuid::new_v4(), Uuid::new_v4());
        for _ in 0..3 {
            send(&limiter, sender).unwrap();
        }
        assert_eq!(send(&limiter, sender), Err(Refusal::Throttled(1)));
        // Two tokens per second: one token after 500 ms.
        limiter.advance(Duration::from_millis(499));
        assert!(send(&limiter, sender).is_err());
        limiter.advance(Duration::from_millis(1));
        send(&limiter, sender).unwrap();
        // Caps and duplicate tracking are unchanged.
        let key = key();
        let _leader = lead(&limiter, key);
        let waiters: Vec<_> = (0..MAX_WAITERS).map(|_| limiter.begin(key)).collect();
        assert!(waiters.iter().all(|w| matches!(w, Ok(Begin::Wait(_)))));
        assert!(matches!(limiter.begin(key), Err(Refusal::Saturated)));
        let max = SendLimit::configured(Some("1000000"), Some("1000000")).unwrap();
        let limiter = SendLimiter::new(max);
        limiter.enforce();
        send(&limiter, sender).unwrap();
        limiter.advance(Duration::from_secs(u64::from(u32::MAX)));
        send(&limiter, sender).unwrap();
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
        let limiter = SendLimiter::new(SendLimit::configured(Some("1000000"), None).unwrap());
        limiter.enforce();
        for _ in 0..MAX_PENDING {
            let mut lead = lead(&limiter, key());
            lead.charge().unwrap();
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
