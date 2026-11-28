//! Fair permit budget for notice queries that share the application pool.
use crate::database::InternalError;
use crate::observability::notice_permits::{
    AllPassGuard, CheckoutGuard, NoticeCaller, NoticePermitGauges, PermitHold, WaitGuard,
    notice_permit_gauges,
};
use std::sync::{Arc, OnceLock, atomic::Ordering::Relaxed};
use tokio::sync::{Semaphore, SemaphorePermit};

pub(super) struct NoticeBudget {
    semaphore: Semaphore,
    gauges: Option<Arc<NoticePermitGauges>>,
}

impl NoticeBudget {
    fn new(permits: usize, gauges: Option<Arc<NoticePermitGauges>>) -> Self {
        let semaphore = Semaphore::new(permits);
        if let Some(gauges) = &gauges {
            gauges.permits_total.store(permits as u64, Relaxed);
        }
        Self { semaphore, gauges }
    }

    pub(super) fn measurement(budget: &OnceLock<Self>) -> Option<&NoticePermitGauges> {
        match budget.get() {
            Some(budget) => budget.gauges.as_deref(),
            None => notice_permit_gauges().map(Arc::as_ref),
        }
    }

    pub(super) fn all_pass(budget: &OnceLock<Self>) -> Option<AllPassGuard<'_>> {
        Self::measurement(budget).map(AllPassGuard::new)
    }

    #[cfg(test)]
    pub(super) fn measured(permits: usize, gauges: Arc<NoticePermitGauges>) -> Self {
        Self::new(permits, Some(gauges))
    }
}

pub(super) async fn notice_query_slot<'a>(
    budget: &'a OnceLock<NoticeBudget>,
    pool: &sqlx::PgPool,
    caller: NoticeCaller,
) -> Result<NoticePermit<'a>, InternalError> {
    // One Activity registry per app pool. Allow up to half the connections for
    // notice authorization, counting the single periodic pass separately so
    // socket retries cannot queue ahead of it. At the minimum pool size (3),
    // allow one query from each lane and leave one connection for other work.
    // Take the permit before checkout and release it before backoff or handoff.
    let budget = budget.get_or_init(|| {
        let half = pool.options().get_max_connections() as usize / 2;
        NoticeBudget::new(
            half.saturating_sub(1).max(1),
            notice_permit_gauges().cloned(),
        )
    });
    let wait = budget
        .gauges
        .as_deref()
        .map(|gauges| WaitGuard::new(gauges, caller));
    let permit = budget
        .semaphore
        .acquire()
        .await
        .map_err(|_| InternalError::Unavailable)?;
    Ok(NoticePermit {
        _permit: permit,
        hold: wait.map(WaitGuard::grant),
    })
}

pub(super) struct NoticePermit<'a> {
    _permit: SemaphorePermit<'a>,
    hold: Option<PermitHold<'a>>,
}

impl NoticePermit<'_> {
    pub(super) fn checkout(&self) -> Option<CheckoutGuard<'_>> {
        self.hold.as_ref().map(PermitHold::checkout)
    }

    pub(super) fn recording(&self) -> bool {
        self.hold.is_some()
    }
}

impl Drop for NoticePermit<'_> {
    fn drop(&mut self) {
        if let Some(hold) = &self.hold {
            hold.finish();
        }
    }
}

#[cfg(test)]
mod tests;
