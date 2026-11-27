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
mod tests {
    use super::*;
    use futures_util::FutureExt;

    #[cfg(feature = "hold-heap-measure")]
    mod heap;

    fn measured_capacity(limit: usize) -> Arc<Capacity> {
        Arc::new(Capacity {
            measure: true,
            ..Capacity::new(limit)
        })
    }

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
        let capacity = Arc::new(Capacity {
            measure: false,
            ..Capacity::new(1)
        });
        let reg = registration(capacity.clone());
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
        // Without the measurement flag, holds and retries leave no measurement trace.
        let counts = capacity.sample();
        assert_eq!((counts.high_water_mark, counts.retry_attempts), (0, 0));
    }

    #[tokio::test(start_paused = true)]
    async fn hold_counts_track_admission_and_release_across_registrations() {
        let capacity = measured_capacity(REGISTRATION_CAP + 1);
        let first = registration(capacity.clone());
        let second = registration(capacity.clone());
        let sample = |active_holds, high_water_mark| {
            let counts = capacity.sample();
            assert_eq!(counts.active_holds, active_holds);
            assert_eq!(counts.high_water_mark, high_water_mark);
            assert_eq!(counts.retry_attempts, 0);
        };
        sample(0, 0);

        let captures = fill(&first, REGISTRATION_CAP + 1);
        assert!(captures[REGISTRATION_CAP].check().is_none());
        sample(REGISTRATION_CAP, REGISTRATION_CAP);
        let overflow = fill(&second, 2);
        assert!(overflow[1].check().is_none());
        let peak = REGISTRATION_CAP + 1;

        {
            let mut b = first.entry.buffer.lock().unwrap();
            // Sample only after release to catch a peak that falls between ticks.
            for (capture, delivered, active) in [
                (&captures[0], true, peak - 1),
                (&captures[1], false, peak - 2),
            ] {
                let id = capture.check().unwrap().id;
                b.holds.complete(id, delivered);
                b.revocations.finish(id);
                sample(active, peak);
            }
            let channel = captures[2].check().unwrap().channel;
            b.revocations
                .capture(ChangeScope::Channel(channel))
                .retire();
            b.retire_notices();
            sample(peak - 3, peak);
        }

        let _entry = second.entry.clone();
        drop(second);
        sample(peak - 4, peak);
        tokio::time::advance(TIMEOUT).await;
        assert!(first.next().now_or_never().is_none());
        sample(0, peak);
        fill(&first, 1);
        sample(1, peak);
        drop(first);
        sample(0, peak);
    }

    #[tokio::test(start_paused = true)]
    async fn retry_attempts_count_only_started_rechecks() {
        let capacity = measured_capacity(1);
        let reg = registration(capacity.clone());
        let (pool, capture) = failed_handoff(&reg).await;
        let channel = capture.check().unwrap().channel;
        assert_eq!(capacity.sample().retry_attempts, 0);

        for (attempt, millis) in [250, 500, 1000, 2000, 4000].into_iter().enumerate() {
            tokio::time::advance(Duration::from_millis(millis)).await;
            let retry = reg.next().now_or_never().flatten().unwrap();
            let gate = pause_member(
                reg.entry.organization,
                channel,
                "handoff_recheck",
                Some(reg.entry.member.0),
            );
            let mut handoff = std::pin::pin!(retry.handoff(&pool, |_| async {
                panic!("a failed retry polled the held write")
            }));
            assert!(handoff.as_mut().now_or_never().is_none());
            assert_eq!(gate.pending_entries(), 1);
            assert_eq!(capacity.sample().retry_attempts, attempt as u64);
            gate.release();
            assert_eq!(handoff.await, None::<()>);
            assert_eq!(capacity.sample().retry_attempts, attempt as u64 + 1);
        }
        assert!(capture.check().is_none());
        let counts = capacity.sample();
        assert_eq!(counts.active_holds, 0);
        assert_eq!(counts.high_water_mark, 1);
    }

    fn measure_notice_budget(
        reg: &Registration,
    ) -> Arc<crate::observability::notice_permits::NoticePermitGauges> {
        let gauges = Arc::default();
        assert!(
            reg.entry
                .notice_queries
                .set(NoticeBudget::measured(1, Arc::clone(&gauges)))
                .is_ok()
        );
        gauges
    }

    #[tokio::test(start_paused = true)]
    async fn retry_deadline_in_permit_wait_counts_pre_attempt_exit() {
        let capacity = measured_capacity(1);
        let reg = registration(capacity.clone());
        let gauges = measure_notice_budget(&reg);
        let (pool, _capture) = failed_handoff(&reg).await;
        let held = notice_query_slot(&reg.entry.notice_queries, &pool, NoticeCaller::Publish)
            .await
            .unwrap();
        tokio::time::advance(BACKOFF).await;
        let retry = reg.next().now_or_never().flatten().unwrap();
        let mut work = std::pin::pin!(retry.handoff(&pool, |_| async {
            panic!("a timed-out retry polled the held write")
        }));
        assert!(work.as_mut().now_or_never().is_none());
        let counters = gauges.caller(NoticeCaller::Retry);
        assert_eq!(counters.waiting.load(Ordering::Relaxed), 1);
        tokio::time::advance(Duration::from_secs(5)).await;
        assert_eq!(work.await, None::<()>);
        assert_eq!(counters.waiting.load(Ordering::Relaxed), 0);
        assert_eq!(counters.holding.load(Ordering::Relaxed), 0);
        assert_eq!(counters.wait_abandoned.load(Ordering::Relaxed), 1);
        assert_eq!(
            counters.wait_abandoned_us_total.load(Ordering::Relaxed),
            5_000_000
        );
        assert_eq!(
            counters
                .deadline_exits_before_attempt
                .load(Ordering::Relaxed),
            1
        );
        assert_eq!(
            counters
                .deadline_exits_after_attempt
                .load(Ordering::Relaxed),
            0
        );
        assert_eq!(capacity.sample().retry_attempts, 0);
        drop(held);
    }

    #[fukulow_test::test]
    async fn retry_deadline_after_grant_counts_post_attempt_exit(pool: sqlx::PgPool) {
        let capacity = measured_capacity(1);
        let reg = registration(capacity.clone());
        let gauges = measure_notice_budget(&reg);
        let (_, capture) = failed_handoff(&reg).await;
        let channel = capture.check().unwrap().channel;
        tokio::time::pause();
        tokio::time::advance(BACKOFF).await;
        let retry = reg.next().now_or_never().flatten().unwrap();
        tokio::time::resume();

        let gate = pause_member(
            reg.entry.organization,
            channel,
            "notice_statement",
            Some(reg.entry.member.0),
        );
        let mut work = std::pin::pin!(retry.handoff(&pool, |_| async {
            panic!("a timed-out retry polled the held write")
        }));
        tokio::select! {
            _ = gate.entered() => {}
            _ = &mut work => panic!("retry finished without entering the statement"),
        }
        let counters = gauges.caller(NoticeCaller::Retry);
        assert_eq!(counters.holding.load(Ordering::Relaxed), 1);
        assert_eq!(counters.holding_checked_out.load(Ordering::Relaxed), 1);
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(5)).await;
        assert_eq!(work.await, None::<()>);
        tokio::time::resume();
        assert_eq!(counters.waiting.load(Ordering::Relaxed), 0);
        assert_eq!(counters.holding.load(Ordering::Relaxed), 0);
        assert_eq!(counters.holding_checked_out.load(Ordering::Relaxed), 0);
        assert_eq!(counters.wait_abandoned.load(Ordering::Relaxed), 0);
        assert_eq!(
            counters
                .deadline_exits_before_attempt
                .load(Ordering::Relaxed),
            0
        );
        assert_eq!(
            counters
                .deadline_exits_after_attempt
                .load(Ordering::Relaxed),
            1
        );
        assert!(counters.statement_us_total.load(Ordering::Relaxed) > 0);
        assert_eq!(capacity.sample().retry_attempts, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn retries_retired_before_recheck_do_not_count() {
        let capacity = measured_capacity(3);
        let fenced = registration(capacity.clone());
        let closed = registration(capacity.clone());
        let expired = registration(capacity.clone());
        let (pool, capture) = failed_handoff(&fenced).await;
        failed_handoff(&closed).await;
        failed_handoff(&expired).await;

        tokio::time::advance(BACKOFF).await;
        let fenced_retry = fenced.next().now_or_never().flatten().unwrap();
        let closed_retry = closed.next().now_or_never().flatten().unwrap();
        let expired_retry = expired.next().now_or_never().flatten().unwrap();
        {
            let channel = capture.check().unwrap().channel;
            let mut b = fenced.entry.buffer.lock().unwrap();
            b.revocations
                .capture(ChangeScope::Channel(channel))
                .retire();
            b.retire_notices();
        }
        drop(closed);
        for retry in [fenced_retry, closed_retry] {
            assert_eq!(retry.handoff(&pool, |_| async {}).await, None);
            assert_eq!(capacity.sample().retry_attempts, 0);
        }

        tokio::time::advance(TIMEOUT).await;
        assert_eq!(expired_retry.handoff(&pool, |_| async {}).await, None);
        let counts = capacity.sample();
        assert_eq!(counts.retry_attempts, 0);
        assert_eq!(counts.active_holds, 0);
        assert_eq!(counts.high_water_mark, 3);
    }
}
