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
    AllPass,
}

const WAIT_MS: [u64; 10] = [1, 5, 10, 50, 100, 250, 500, 1000, 2500, 5000];
const WAIT_BUCKETS: usize = WAIT_MS.len();
const PERMIT_CALLERS: usize = NoticeCaller::AllPass as usize;

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

impl NoticePermitGauges {
    pub(super) fn emit(&self) {
        // Dotted fields keep each caller's numbers together in the single tracing event.
        macro_rules! sample {
            ($($tag:ident: $caller:ident, $wait:ident, $granted:ident, $abandoned:ident);+ $(;)?) => {
                $(
                    let $tag = self.caller(NoticeCaller::$caller);
                    let $wait = self.cumulative_waits(NoticeCaller::$caller);
                    let $granted = $tag.granted.load(Relaxed);
                    let $abandoned = $tag.wait_abandoned.load(Relaxed);
                )+
                let retry = self.caller(NoticeCaller::Retry);
                let handoff = self.caller(NoticeCaller::Handoff);
                tracing::trace!(
                    target: REVOCATION_MEASUREMENT_TARGET,
                    parent: None,
                    event = "notice_permit_sample",
                    server_ms = measurement_ms(),
                    permits_total = self.permits_total.load(Relaxed),
                    all_pass_in_flight = self.all_pass_in_flight.load(Relaxed),
                    all_pass_statements = self.all_pass_statements.load(Relaxed),
                    all_pass_us_total = self.all_pass_us_total.load(Relaxed),
                    retry.deadline_exits_before_attempt = retry.deadline_exits_before_attempt.load(Relaxed),
                    retry.deadline_exits_after_attempt = retry.deadline_exits_after_attempt.load(Relaxed),
                    handoff.deadline_exits_before_attempt = handoff.deadline_exits_before_attempt.load(Relaxed),
                    handoff.deadline_exits_after_attempt = handoff.deadline_exits_after_attempt.load(Relaxed),
                    $(
                        $tag.waiting = $tag.waiting.load(Relaxed),
                        $tag.holding = $tag.holding.load(Relaxed),
                        $tag.holding_checked_out = $tag.holding_checked_out.load(Relaxed),
                        $tag.granted = $granted,
                        $tag.wait_abandoned = $abandoned,
                        $tag.wait_count = $granted + $abandoned,
                        $tag.wait_granted_us_total = $tag.wait_granted_us_total.load(Relaxed),
                        $tag.wait_abandoned_us_total = $tag.wait_abandoned_us_total.load(Relaxed),
                        $tag.hold_us_total = $tag.hold_us_total.load(Relaxed),
                        $tag.pool_wait_us_total = $tag.pool_wait_us_total.load(Relaxed),
                        $tag.statement_us_total = $tag.statement_us_total.load(Relaxed),
                        $tag.wait_le_1_ms = $wait[0],
                        $tag.wait_le_5_ms = $wait[1],
                        $tag.wait_le_10_ms = $wait[2],
                        $tag.wait_le_50_ms = $wait[3],
                        $tag.wait_le_100_ms = $wait[4],
                        $tag.wait_le_250_ms = $wait[5],
                        $tag.wait_le_500_ms = $wait[6],
                        $tag.wait_le_1000_ms = $wait[7],
                        $tag.wait_le_2500_ms = $wait[8],
                        $tag.wait_le_5000_ms = $wait[9],
                    )+
                );
            };
        }
        sample! {
            retry: Retry, retry_wait, retry_granted, retry_abandoned;
            handoff: Handoff, handoff_wait, handoff_granted, handoff_abandoned;
            publish: Publish, publish_wait, publish_granted, publish_abandoned;
            revoked: Revoked, revoked_wait, revoked_granted, revoked_abandoned;
            scoped: Scoped, scoped_wait, scoped_granted, scoped_abandoned;
        }
    }
}
