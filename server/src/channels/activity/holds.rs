use super::*;
use crate::observability::{RevocationMetric, RevocationMetrics, revocation_metrics};
use std::{
    collections::BTreeMap,
    sync::{LazyLock, MutexGuard},
};

const REGISTRATION_CAP: usize = 64;
const GLOBAL_CAP: usize = 4096;
const TIMEOUT: Duration = Duration::from_secs(30);
const RETRIES: u32 = 5;
const BACKOFF: Duration = Duration::from_millis(250);
const MAX_BACKOFF: Duration = Duration::from_secs(4);
static CAPACITY: LazyLock<Arc<Capacity>> = LazyLock::new(|| Arc::new(Capacity::new(GLOBAL_CAP)));

type HoldKey = (Instant, Uuid, u64);

struct Capacity {
    limit: usize,
    owners: Mutex<BTreeMap<HoldKey, Weak<Entry>>>,
}

impl Capacity {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            owners: Mutex::default(),
        }
    }

    fn reserve(self: &Arc<Self>, entry: &Arc<Entry>, id: u64, expires: Instant) -> Option<Permit> {
        let mut owners = self.owners.lock().unwrap_or_else(|e| e.into_inner());
        if owners.len() >= self.limit {
            return None;
        }
        let key = (expires, entry.id, id);
        owners.insert(key, Arc::downgrade(entry));
        Some(Permit {
            capacity: self.clone(),
            key,
        })
    }

    fn expired(&self, now: Instant) -> Option<(HoldKey, Weak<Entry>)> {
        let owners = self.owners.lock().unwrap_or_else(|e| e.into_inner());
        let (&key, entry) = owners.first_key_value()?;
        (key.0 <= now).then(|| (key, entry.clone()))
    }

    fn release(&self, key: HoldKey) {
        self.owners
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&key);
    }

    #[cfg(test)]
    fn available_permits(&self) -> usize {
        self.limit - self.owners.lock().unwrap().len()
    }
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
        let mut b = entry.buffer.lock().unwrap_or_else(|e| e.into_inner());
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
            let mut b = owner.buffer.lock().unwrap_or_else(|e| e.into_inner());
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
mod tests {
    use super::*;
    use futures_util::FutureExt;

    fn registration(capacity: Arc<Capacity>) -> Registration {
        let entry = crate::channels::activity::tests::entry();
        {
            let mut b = entry.buffer.lock().unwrap();
            b.holds.capacity = capacity;
            b.holds.metrics = Arc::default();
        }
        Registration {
            id: entry.id,
            entry,
            registry: Weak::new(),
        }
    }

    fn add_revocation(b: &mut Buffer) -> Arc<Capture> {
        let channel = Uuid::new_v4();
        let mutation = b.revocations.capture(ChangeScope::Channel(channel));
        let capture = mutation.notice(channel, false, Role::Member).unwrap();
        b.revocations
            .apply(capture.check().unwrap(), Some(Role::Member), Some(false));
        capture
    }

    fn fill(reg: &Registration, count: usize) -> Vec<Arc<Capture>> {
        let (mut b, now) = lock_for_admission(&reg.entry);
        (0..count)
            .map(|_| {
                let capture = add_revocation(&mut b);
                let id = capture.check().unwrap().id;
                let Buffer {
                    holds, revocations, ..
                } = &mut *b;
                holds.start(&reg.entry, revocations, id, now);
                capture
            })
            .collect()
    }

    fn metric(reg: &Registration, metric: RevocationMetric) -> u64 {
        reg.entry.buffer.lock().unwrap().holds.metrics.load(metric)
    }

    fn revocation(capture: Arc<Capture>) -> Pending {
        Pending {
            notice: Notice::ChannelAccessRevoked {
                channel_id: capture.check().unwrap().channel,
            },
            channel: None,
            epoch: Epoch::Revocation(capture),
            directory_epoch: None,
            proof: None,
            valid: Arc::new(QueryToken::new()),
            recovery: None,
        }
    }

    #[test]
    fn registration_cap_retires_revocation() {
        let capacity = Arc::new(Capacity::new(GLOBAL_CAP));
        let reg = registration(capacity.clone());
        let captures = fill(&reg, REGISTRATION_CAP + 1);
        assert!(
            captures[REGISTRATION_CAP].check().is_none(),
            "overflow was not fenced"
        );
        assert!(
            captures[..REGISTRATION_CAP]
                .iter()
                .all(|c| c.check().is_some())
        );
        assert_eq!(
            metric(&reg, RevocationMetric::Held),
            REGISTRATION_CAP as u64
        );
        assert_eq!(metric(&reg, RevocationMetric::RegistrationCap), 1);
        assert_eq!(metric(&reg, RevocationMetric::GlobalCap), 0);
        drop(reg);
        assert_eq!(capacity.available_permits(), GLOBAL_CAP);
    }

    #[test]
    fn global_cap_retires_revocation() {
        let capacity = Arc::new(Capacity::new(GLOBAL_CAP));
        let registrations: Vec<_> = (0..GLOBAL_CAP.div_ceil(REGISTRATION_CAP))
            .map(|_| {
                let count = capacity.available_permits().min(REGISTRATION_CAP);
                let reg = registration(capacity.clone());
                let captures = fill(&reg, count);
                (reg, captures)
            })
            .collect();
        let extra = registration(capacity.clone());
        let overflow = fill(&extra, 1);
        assert!(
            overflow[0].check().is_none(),
            "process overflow was not fenced"
        );
        assert_eq!(metric(&extra, RevocationMetric::GlobalCap), 1);
        assert_eq!(metric(&extra, RevocationMetric::RegistrationCap), 0);
        assert_eq!(metric(&extra, RevocationMetric::Held), 0);
        drop(registrations);
        let admitted = fill(&extra, 1);
        assert!(admitted[0].check().is_some());
        assert_eq!(metric(&extra, RevocationMetric::Held), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn admission_reclaims_expired_hold_from_unpolled_registration() {
        let capacity = Arc::new(Capacity::new(1));
        let first = registration(capacity.clone());
        let second = registration(capacity.clone());
        let (_, expired) = failed_handoff(&first).await;
        assert_eq!(capacity.available_permits(), 0);

        tokio::time::advance(TIMEOUT + Duration::from_millis(1)).await;
        let (_, admitted) = failed_handoff(&second).await;
        assert_eq!(
            metric(&second, RevocationMetric::Held),
            1,
            "second registration could not acquire the expired slot"
        );
        assert_eq!(metric(&second, RevocationMetric::GlobalCap), 0);
        assert!(admitted.check().is_some());
        assert!(expired.check().is_none());
        assert_eq!(metric(&first, RevocationMetric::Timeout), 1);
    }

    #[fukulow_test::test]
    async fn retried_overflow_reset_does_not_count_as_revocation_delivery(pool: sqlx::PgPool) {
        let organization = crate::channels::tests::organization(&pool).await;
        let token =
            crate::channels::tests::member(&pool, organization, Uuid::new_v4(), "member").await;
        let auth = crate::channels::tests::extract_auth(
            crate::AppState::for_test(pool.clone()).await,
            &token,
        )
        .await;
        let activity = Activity::default();
        let reg = activity.register(&auth);
        let metrics = reg.isolate_revocation_metrics();
        tokio::time::pause();
        let capture = fill(&reg, 1).pop().unwrap();
        let channel = Uuid::new_v4();
        for _ in 0..256 {
            enqueue(
                &reg.entry,
                crate::channels::activity::tests::pending(channel, Some(Uuid::new_v4())),
            );
        }
        enqueue(&reg.entry, revocation(capture.clone()));
        let reset = reg
            .next()
            .now_or_never()
            .flatten()
            .expect("overflow did not latch a reset");
        assert_eq!(reset.event, Notice::ActivityReset);
        assert_eq!(
            reset
                .handoff(&pool, |_| async {
                    panic!("an unchecked hold polled the reset write")
                })
                .await,
            None::<()>
        );
        tokio::time::advance(BACKOFF).await;
        tokio::time::resume();

        let retry = reg
            .next()
            .now_or_never()
            .flatten()
            .expect("overflow reset was not retried");
        assert_eq!(
            retry.handoff(&pool, |event| async { event }).await,
            Some(Notice::ActivityReset)
        );
        assert!(capture.check().is_none());
        assert_eq!(metrics.load(RevocationMetric::Held), 1);
        assert_eq!(
            metrics.load(RevocationMetric::Delivered),
            0,
            "reset counted as revocation delivery"
        );
    }

    #[test]
    fn fences_retire_holds() {
        let capacity = Arc::new(Capacity::new(3));
        let reg = registration(capacity.clone());
        let private = fill(&reg, 2);
        let first = private[0].check().unwrap().channel;
        {
            let mut b = reg.entry.buffer.lock().unwrap();
            let role = b.revocations.capture(ChangeScope::Role);
            let public = role.notice(Uuid::new_v4(), true, Role::Guest).unwrap();
            let id = public.check().unwrap().id;
            let Buffer {
                holds, revocations, ..
            } = &mut *b;
            holds.start(&reg.entry, revocations, id, Instant::now());
            assert_eq!(capacity.available_permits(), 0);

            b.revocations.capture(ChangeScope::Role).retire();
            b.retire_notices();
            assert!(public.check().is_none());
            assert_eq!(
                capacity.available_permits(),
                1,
                "Role fence kept the public hold"
            );
            assert!(private.iter().all(|c| c.check().unwrap().needs_recheck));

            b.revocations.capture(ChangeScope::Channel(first)).retire();
            b.retire_notices();
            assert!(private[0].check().is_none());
            assert_eq!(
                capacity.available_permits(),
                2,
                "Channel fence kept its hold"
            );
            assert!(private[1].check().is_some());

            b.revocations.retire_member();
            b.retire_notices();
            assert!(private[1].check().is_none());
            assert_eq!(
                capacity.available_permits(),
                3,
                "Membership fence kept its hold"
            );
        }
        assert_eq!(metric(&reg, RevocationMetric::Fenced), 3);
        let captured = fill(&reg, 1);
        let _in_flight = reg.entry.clone();
        drop(reg);
        assert!(captured[0].check().is_none());
        assert_eq!(capacity.available_permits(), 3);
    }

    async fn failed_handoff(reg: &Registration) -> (sqlx::PgPool, Arc<Capture>) {
        let (capture, frame) = {
            let mut b = reg.entry.buffer.lock().unwrap();
            let capture = add_revocation(&mut b);
            b.revocations.capture(ChangeScope::Role).retire();
            let frame = NoticeFrame::new(&reg.entry, revocation(capture.clone()), false);
            (capture, frame)
        };
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy_with(sqlx::postgres::PgConnectOptions::new());
        pool.close().await;
        assert_eq!(
            frame
                .handoff(&pool, |_| async {
                    panic!("failed authorization polled the initial write")
                })
                .await,
            None::<()>
        );
        assert_eq!(metric(reg, RevocationMetric::RecheckError), 1);
        (pool, capture)
    }

    #[tokio::test(start_paused = true)]
    async fn hold_timeout_retires_revocation() {
        let reg = registration(Arc::new(Capacity::new(1)));
        let (_, capture) = failed_handoff(&reg).await;
        tokio::time::advance(TIMEOUT).await;
        assert!(
            reg.next().now_or_never().is_none(),
            "expired frame was ready for retry"
        );
        assert!(capture.check().is_none());
        assert_eq!(metric(&reg, RevocationMetric::Timeout), 1);
        assert_eq!(metric(&reg, RevocationMetric::Retries), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn retry_limit_retires_revocation() {
        let reg = registration(Arc::new(Capacity::new(1)));
        let (pool, capture) = failed_handoff(&reg).await;
        for (attempt, millis) in [250, 500, 1000, 2000, 4000].into_iter().enumerate() {
            let mut next = std::pin::pin!(reg.next());
            assert!(next.as_mut().now_or_never().is_none());
            let tick = Duration::from_millis(1);
            tokio::time::advance(Duration::from_millis(millis) - tick).await;
            assert!(next.as_mut().now_or_never().is_none(), "retry ran early");
            tokio::time::advance(tick).await;
            let retry = next
                .as_mut()
                .now_or_never()
                .flatten()
                .expect("retry timer did not wake the registration");
            assert_eq!(
                retry
                    .handoff(&pool, |_| async {
                        panic!("a failed retry polled the held write")
                    })
                    .await,
                None::<()>
            );
            assert_eq!(
                metric(&reg, RevocationMetric::RecheckError),
                attempt as u64 + 2
            );
            assert_eq!(metric(&reg, RevocationMetric::Held), 1);
            assert_eq!(metric(&reg, RevocationMetric::Delivered), 0);
        }
        assert!(
            capture.check().is_none(),
            "the fifth failure left the hold live"
        );
        assert_eq!(metric(&reg, RevocationMetric::Retries), 1);
        assert_eq!(metric(&reg, RevocationMetric::Timeout), 0);
    }
}
