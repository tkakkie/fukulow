//! Process-local measurement of notice-query permits.
use super::{REVOCATION_MEASUREMENT_TARGET, measurement_ms, revocation_measurement_enabled};
use std::sync::{
    Arc, LazyLock,
    atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering::Relaxed},
};
use tokio::time::Instant;

#[derive(Clone, Copy)]
pub(crate) enum NoticeCaller {
    Retry,
    Handoff,
    Publish,
    Revoked,
    Scoped,
}

const WAIT_MS: [u64; 10] = [1, 5, 10, 50, 100, 250, 500, 1000, 2500, 5000];
const WAIT_BUCKETS: usize = WAIT_MS.len();
const PERMIT_CALLERS: usize = [
    NoticeCaller::Retry,
    NoticeCaller::Handoff,
    NoticeCaller::Publish,
    NoticeCaller::Revoked,
    NoticeCaller::Scoped,
]
.len();

pub(crate) struct PermitCounters {
    pub waiting: AtomicI64,
    pub holding: AtomicI64,
    pub holding_checked_out: AtomicI64,
    pub granted: AtomicU64,
    pub wait_abandoned: AtomicU64,
    pub wait_granted_us_total: AtomicU64,
    pub wait_abandoned_us_total: AtomicU64,
    pub hold_us_total: AtomicU64,
    pub pool_wait_us_total: AtomicU64,
    pub statement_us_total: AtomicU64,
    pub deadline_exits_before_attempt: AtomicU64,
    pub deadline_exits_after_attempt: AtomicU64,
}

impl PermitCounters {
    const fn zero() -> Self {
        Self {
            waiting: AtomicI64::new(0),
            holding: AtomicI64::new(0),
            holding_checked_out: AtomicI64::new(0),
            granted: AtomicU64::new(0),
            wait_abandoned: AtomicU64::new(0),
            wait_granted_us_total: AtomicU64::new(0),
            wait_abandoned_us_total: AtomicU64::new(0),
            hold_us_total: AtomicU64::new(0),
            pool_wait_us_total: AtomicU64::new(0),
            statement_us_total: AtomicU64::new(0),
            deadline_exits_before_attempt: AtomicU64::new(0),
            deadline_exits_after_attempt: AtomicU64::new(0),
        }
    }
}

pub(crate) struct NoticePermitGauges {
    callers: Box<[PermitCounters]>,
    wait_buckets: Box<[AtomicU64]>,
    pub permits_total: AtomicU64,
    pub all_pass_in_flight: AtomicI64,
    pub all_pass_statements: AtomicU64,
    pub all_pass_us_total: AtomicU64,
}

impl Default for NoticePermitGauges {
    fn default() -> Self {
        Self {
            callers: Box::new([const { PermitCounters::zero() }; PERMIT_CALLERS]),
            wait_buckets: Box::new([const { AtomicU64::new(0) }; PERMIT_CALLERS * WAIT_BUCKETS]),
            permits_total: AtomicU64::new(0),
            all_pass_in_flight: AtomicI64::new(0),
            all_pass_statements: AtomicU64::new(0),
            all_pass_us_total: AtomicU64::new(0),
        }
    }
}

pub(crate) fn notice_permit_gauges() -> Option<&'static Arc<NoticePermitGauges>> {
    static GAUGES: LazyLock<Arc<NoticePermitGauges>> = LazyLock::new(Arc::default);
    revocation_measurement_enabled().then(|| &*GAUGES)
}

impl NoticePermitGauges {
    pub(crate) fn caller(&self, caller: NoticeCaller) -> &PermitCounters {
        &self.callers[caller as usize]
    }

    fn wait_buckets(&self, caller: NoticeCaller) -> &[AtomicU64] {
        let start = caller as usize * WAIT_BUCKETS;
        &self.wait_buckets[start..start + WAIT_BUCKETS]
    }

    pub(crate) fn deadline_exit(&self, caller: NoticeCaller, granted: bool) {
        let c = self.caller(caller);
        let counter = if granted {
            &c.deadline_exits_after_attempt
        } else {
            &c.deadline_exits_before_attempt
        };
        counter.fetch_add(1, Relaxed);
    }

    pub(crate) fn cumulative_waits(&self, caller: NoticeCaller) -> [u64; WAIT_BUCKETS] {
        let mut total = 0;
        std::array::from_fn(|i| {
            total += self.wait_buckets(caller)[i].load(Relaxed);
            total
        })
    }
}

pub(crate) struct WaitGuard<'a> {
    gauges: &'a NoticePermitGauges,
    caller: NoticeCaller,
    started: Instant,
    granted_at: Option<Instant>,
}

impl<'a> WaitGuard<'a> {
    pub(crate) fn new(gauges: &'a NoticePermitGauges, caller: NoticeCaller) -> Self {
        gauges.caller(caller).waiting.fetch_add(1, Relaxed);
        Self {
            gauges,
            caller,
            started: Instant::now(),
            granted_at: None,
        }
    }

    pub(crate) fn grant(mut self) -> PermitHold<'a> {
        let granted_at = Instant::now();
        self.granted_at = Some(granted_at);
        let counters = self.gauges.caller(self.caller);
        counters.holding.fetch_add(1, Relaxed);
        PermitHold {
            gauges: self.gauges,
            caller: self.caller,
            granted_at,
            checked_out: AtomicBool::new(false),
        }
    }
}

impl Drop for WaitGuard<'_> {
    fn drop(&mut self) {
        let elapsed = self.granted_at.unwrap_or_else(Instant::now) - self.started;
        let counters = self.gauges.caller(self.caller);
        let (count, total) = if self.granted_at.is_some() {
            (&counters.granted, &counters.wait_granted_us_total)
        } else {
            (&counters.wait_abandoned, &counters.wait_abandoned_us_total)
        };
        count.fetch_add(1, Relaxed);
        total.fetch_add(elapsed.as_micros() as u64, Relaxed);
        if let Some(i) = WAIT_MS
            .iter()
            .position(|ms| elapsed <= std::time::Duration::from_millis(*ms))
        {
            self.gauges.wait_buckets(self.caller)[i].fetch_add(1, Relaxed);
        }
        counters.waiting.fetch_sub(1, Relaxed);
    }
}

/// Measurement state owned by the semaphore permit.
pub(crate) struct PermitHold<'a> {
    gauges: &'a NoticePermitGauges,
    caller: NoticeCaller,
    granted_at: Instant,
    checked_out: AtomicBool,
}

impl PermitHold<'_> {
    pub(crate) fn checkout(&self) -> CheckoutGuard<'_> {
        let started = Instant::now();
        let counters = self.gauges.caller(self.caller);
        self.checked_out.store(true, Relaxed);
        counters
            .pool_wait_us_total
            .fetch_add((started - self.granted_at).as_micros() as u64, Relaxed);
        counters.holding_checked_out.fetch_add(1, Relaxed);
        CheckoutGuard { counters, started }
    }

    pub(crate) fn finish(&self) {
        let elapsed = self.granted_at.elapsed().as_micros() as u64;
        let counters = self.gauges.caller(self.caller);
        if !self.checked_out.load(Relaxed) {
            counters.pool_wait_us_total.fetch_add(elapsed, Relaxed);
        }
        counters.hold_us_total.fetch_add(elapsed, Relaxed);
        counters.holding.fetch_sub(1, Relaxed);
    }
}

pub(crate) struct CheckoutGuard<'a> {
    counters: &'a PermitCounters,
    started: Instant,
}

impl Drop for CheckoutGuard<'_> {
    fn drop(&mut self) {
        self.counters
            .statement_us_total
            .fetch_add(self.started.elapsed().as_micros() as u64, Relaxed);
        self.counters.holding_checked_out.fetch_sub(1, Relaxed);
    }
}

pub(crate) struct AllPassGuard<'a> {
    gauges: &'a NoticePermitGauges,
    started: Instant,
}

impl<'a> AllPassGuard<'a> {
    pub(crate) fn new(gauges: &'a NoticePermitGauges) -> Self {
        gauges.all_pass_in_flight.fetch_add(1, Relaxed);
        Self {
            gauges,
            started: Instant::now(),
        }
    }
}

impl Drop for AllPassGuard<'_> {
    fn drop(&mut self) {
        self.gauges.all_pass_statements.fetch_add(1, Relaxed);
        self.gauges
            .all_pass_us_total
            .fetch_add(self.started.elapsed().as_micros() as u64, Relaxed);
        self.gauges.all_pass_in_flight.fetch_sub(1, Relaxed);
    }
}

struct PermitSample<'a> {
    counters: &'a PermitCounters,
    waits: [u64; WAIT_BUCKETS],
    granted: u64,
    abandoned: u64,
}

impl NoticePermitGauges {
    fn sample(&self, caller: NoticeCaller) -> PermitSample<'_> {
        let counters = self.caller(caller);
        PermitSample {
            counters,
            waits: self.cumulative_waits(caller),
            granted: counters.granted.load(Relaxed),
            abandoned: counters.wait_abandoned.load(Relaxed),
        }
    }

    pub(super) fn emit(&self) {
        let retry = self.sample(NoticeCaller::Retry);
        let handoff = self.sample(NoticeCaller::Handoff);
        let publish = self.sample(NoticeCaller::Publish);
        let revoked = self.sample(NoticeCaller::Revoked);
        let scoped = self.sample(NoticeCaller::Scoped);

        // Dotted fields keep each caller's numbers together in the single tracing event.
        tracing::trace!(
            target: REVOCATION_MEASUREMENT_TARGET,
            parent: None,
            event = "notice_permit_sample",
            server_ms = measurement_ms(),
            permits_total = self.permits_total.load(Relaxed),
            all_pass_in_flight = self.all_pass_in_flight.load(Relaxed),
            all_pass_statements = self.all_pass_statements.load(Relaxed),
            all_pass_us_total = self.all_pass_us_total.load(Relaxed),
            retry.deadline_exits_before_attempt = retry.counters.deadline_exits_before_attempt.load(Relaxed),
            retry.deadline_exits_after_attempt = retry.counters.deadline_exits_after_attempt.load(Relaxed),
            handoff.deadline_exits_before_attempt = handoff.counters.deadline_exits_before_attempt.load(Relaxed),
            handoff.deadline_exits_after_attempt = handoff.counters.deadline_exits_after_attempt.load(Relaxed),
            retry.waiting = retry.counters.waiting.load(Relaxed),
            retry.holding = retry.counters.holding.load(Relaxed),
            retry.holding_checked_out = retry.counters.holding_checked_out.load(Relaxed),
            retry.granted = retry.granted,
            retry.wait_abandoned = retry.abandoned,
            retry.wait_count = retry.granted + retry.abandoned,
            retry.wait_granted_us_total = retry.counters.wait_granted_us_total.load(Relaxed),
            retry.wait_abandoned_us_total = retry.counters.wait_abandoned_us_total.load(Relaxed),
            retry.hold_us_total = retry.counters.hold_us_total.load(Relaxed),
            retry.pool_wait_us_total = retry.counters.pool_wait_us_total.load(Relaxed),
            retry.statement_us_total = retry.counters.statement_us_total.load(Relaxed),
            retry.wait_le_1_ms = retry.waits[0],
            retry.wait_le_5_ms = retry.waits[1],
            retry.wait_le_10_ms = retry.waits[2],
            retry.wait_le_50_ms = retry.waits[3],
            retry.wait_le_100_ms = retry.waits[4],
            retry.wait_le_250_ms = retry.waits[5],
            retry.wait_le_500_ms = retry.waits[6],
            retry.wait_le_1000_ms = retry.waits[7],
            retry.wait_le_2500_ms = retry.waits[8],
            retry.wait_le_5000_ms = retry.waits[9],
            handoff.waiting = handoff.counters.waiting.load(Relaxed),
            handoff.holding = handoff.counters.holding.load(Relaxed),
            handoff.holding_checked_out = handoff.counters.holding_checked_out.load(Relaxed),
            handoff.granted = handoff.granted,
            handoff.wait_abandoned = handoff.abandoned,
            handoff.wait_count = handoff.granted + handoff.abandoned,
            handoff.wait_granted_us_total = handoff.counters.wait_granted_us_total.load(Relaxed),
            handoff.wait_abandoned_us_total = handoff.counters.wait_abandoned_us_total.load(Relaxed),
            handoff.hold_us_total = handoff.counters.hold_us_total.load(Relaxed),
            handoff.pool_wait_us_total = handoff.counters.pool_wait_us_total.load(Relaxed),
            handoff.statement_us_total = handoff.counters.statement_us_total.load(Relaxed),
            handoff.wait_le_1_ms = handoff.waits[0],
            handoff.wait_le_5_ms = handoff.waits[1],
            handoff.wait_le_10_ms = handoff.waits[2],
            handoff.wait_le_50_ms = handoff.waits[3],
            handoff.wait_le_100_ms = handoff.waits[4],
            handoff.wait_le_250_ms = handoff.waits[5],
            handoff.wait_le_500_ms = handoff.waits[6],
            handoff.wait_le_1000_ms = handoff.waits[7],
            handoff.wait_le_2500_ms = handoff.waits[8],
            handoff.wait_le_5000_ms = handoff.waits[9],
            publish.waiting = publish.counters.waiting.load(Relaxed),
            publish.holding = publish.counters.holding.load(Relaxed),
            publish.holding_checked_out = publish.counters.holding_checked_out.load(Relaxed),
            publish.granted = publish.granted,
            publish.wait_abandoned = publish.abandoned,
            publish.wait_count = publish.granted + publish.abandoned,
            publish.wait_granted_us_total = publish.counters.wait_granted_us_total.load(Relaxed),
            publish.wait_abandoned_us_total = publish.counters.wait_abandoned_us_total.load(Relaxed),
            publish.hold_us_total = publish.counters.hold_us_total.load(Relaxed),
            publish.pool_wait_us_total = publish.counters.pool_wait_us_total.load(Relaxed),
            publish.statement_us_total = publish.counters.statement_us_total.load(Relaxed),
            publish.wait_le_1_ms = publish.waits[0],
            publish.wait_le_5_ms = publish.waits[1],
            publish.wait_le_10_ms = publish.waits[2],
            publish.wait_le_50_ms = publish.waits[3],
            publish.wait_le_100_ms = publish.waits[4],
            publish.wait_le_250_ms = publish.waits[5],
            publish.wait_le_500_ms = publish.waits[6],
            publish.wait_le_1000_ms = publish.waits[7],
            publish.wait_le_2500_ms = publish.waits[8],
            publish.wait_le_5000_ms = publish.waits[9],
            revoked.waiting = revoked.counters.waiting.load(Relaxed),
            revoked.holding = revoked.counters.holding.load(Relaxed),
            revoked.holding_checked_out = revoked.counters.holding_checked_out.load(Relaxed),
            revoked.granted = revoked.granted,
            revoked.wait_abandoned = revoked.abandoned,
            revoked.wait_count = revoked.granted + revoked.abandoned,
            revoked.wait_granted_us_total = revoked.counters.wait_granted_us_total.load(Relaxed),
            revoked.wait_abandoned_us_total = revoked.counters.wait_abandoned_us_total.load(Relaxed),
            revoked.hold_us_total = revoked.counters.hold_us_total.load(Relaxed),
            revoked.pool_wait_us_total = revoked.counters.pool_wait_us_total.load(Relaxed),
            revoked.statement_us_total = revoked.counters.statement_us_total.load(Relaxed),
            revoked.wait_le_1_ms = revoked.waits[0],
            revoked.wait_le_5_ms = revoked.waits[1],
            revoked.wait_le_10_ms = revoked.waits[2],
            revoked.wait_le_50_ms = revoked.waits[3],
            revoked.wait_le_100_ms = revoked.waits[4],
            revoked.wait_le_250_ms = revoked.waits[5],
            revoked.wait_le_500_ms = revoked.waits[6],
            revoked.wait_le_1000_ms = revoked.waits[7],
            revoked.wait_le_2500_ms = revoked.waits[8],
            revoked.wait_le_5000_ms = revoked.waits[9],
            scoped.waiting = scoped.counters.waiting.load(Relaxed),
            scoped.holding = scoped.counters.holding.load(Relaxed),
            scoped.holding_checked_out = scoped.counters.holding_checked_out.load(Relaxed),
            scoped.granted = scoped.granted,
            scoped.wait_abandoned = scoped.abandoned,
            scoped.wait_count = scoped.granted + scoped.abandoned,
            scoped.wait_granted_us_total = scoped.counters.wait_granted_us_total.load(Relaxed),
            scoped.wait_abandoned_us_total = scoped.counters.wait_abandoned_us_total.load(Relaxed),
            scoped.hold_us_total = scoped.counters.hold_us_total.load(Relaxed),
            scoped.pool_wait_us_total = scoped.counters.pool_wait_us_total.load(Relaxed),
            scoped.statement_us_total = scoped.counters.statement_us_total.load(Relaxed),
            scoped.wait_le_1_ms = scoped.waits[0],
            scoped.wait_le_5_ms = scoped.waits[1],
            scoped.wait_le_10_ms = scoped.waits[2],
            scoped.wait_le_50_ms = scoped.waits[3],
            scoped.wait_le_100_ms = scoped.waits[4],
            scoped.wait_le_250_ms = scoped.waits[5],
            scoped.wait_le_500_ms = scoped.waits[6],
            scoped.wait_le_1000_ms = scoped.waits[7],
            scoped.wait_le_2500_ms = scoped.waits[8],
            scoped.wait_le_5000_ms = scoped.waits[9],
        );
    }
}
