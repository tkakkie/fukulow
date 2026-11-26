use super::{BATCH_ROWS, has_expired, purge};
use crate::{auth::members::next_maintenance_organization, shutdown::Shutdown};
use sqlx::PgPool;
use std::{
    collections::{HashSet, VecDeque},
    time::Duration,
};
use tokio::time::{Instant, timeout_at};
use uuid::Uuid;

const DISCOVERY_LIMIT: usize = 32;
const BATCH_LIMIT: usize = 10;
const DISCOVERY_BUDGET: Duration = Duration::from_millis(100);
const TICK_BUDGET: Duration = Duration::from_millis(250);

#[derive(Default)]
pub(in crate::messages) struct Purge {
    after: Option<Uuid>,
    queue: VecDeque<Uuid>,
    queued: HashSet<Uuid>,
}

impl Purge {
    async fn discover(&mut self, pool: &PgPool) -> Result<bool, sqlx::Error> {
        let mut first = None;
        let mut wrapped = false;
        for _ in 0..DISCOVERY_LIMIT {
            let Some(org) = next_maintenance_organization(pool, self.after).await? else {
                break;
            };
            if first == Some(org) {
                break;
            }
            first.get_or_insert(org);
            if !self.queued.contains(&org) && has_expired(pool, org).await? {
                self.queued.insert(org);
                self.queue.push_back(org);
            }
            wrapped |= self.after.is_some_and(|after| org <= after);
            self.after = Some(org);
        }
        Ok(wrapped)
    }

    async fn reclaim(&mut self, pool: &PgPool) -> Result<(), sqlx::Error> {
        for _ in 0..BATCH_LIMIT {
            let Some(&org) = self.queue.front() else {
                break;
            };
            // Move to the tail before I/O so a timed-out batch still yields its turn.
            self.queue.rotate_left(1);
            if purge(pool, org).await? < BATCH_ROWS {
                self.queue.pop_back();
                self.queued.remove(&org);
            }
        }
        Ok(())
    }

    pub(in crate::messages) async fn tick(
        &mut self,
        pool: &PgPool,
        discovery_budget: Duration,
        tick_budget: Duration,
    ) {
        let start = Instant::now();
        let wrapped = match timeout_at(start + discovery_budget, self.discover(pool)).await {
            Ok(Ok(wrapped)) => wrapped,
            _ => {
                tracing::warn!(target: "fukulow", event = "database_failure", operation = "operation_receipts_discovery");
                false
            }
        };
        if !matches!(
            timeout_at(start + tick_budget, self.reclaim(pool)).await,
            Ok(Ok(()))
        ) {
            tracing::warn!(target: "fukulow", event = "database_failure", operation = "operation_receipts_expiry");
        }
        if wrapped {
            tracing::debug!(target: "fukulow::receipt_purge", event = "receipt_discovery_sweep");
        }
    }
}

/// The runtime role calls the existing maintenance SECURITY DEFINER for
/// Organization IDs only. Receipt probes and deletes run under scoped RLS.
///
/// Each one-second tick allows 250 ms total, at most 100 ms for 32 discoveries
/// and at most ten 1,000-row delete attempts. Capacity per worker is up to
/// 10,000 rows/s total and 10,000/K rows/s per Organization for K continuously
/// full queues. Each gets a turn every K attempts. For a fixed set of N
/// Organizations, full tick budgets reach
/// a new backlog in at most ceil(N/32) discovery + ceil(N/10) delete ticks.
/// If each nonempty phase completes at least one slot per tick, the bound is
/// 2N ticks. Database stalls and missed ticks can extend elapsed time.
pub async fn purge_periodically(pool: PgPool, shutdown: Shutdown) {
    let mut ticks = tokio::time::interval(Duration::from_secs(1));
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut purge = Purge::default();
    loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => return,
            _ = ticks.tick() => {}
        }
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => return,
            _ = purge.tick(&pool, DISCOVERY_BUDGET, TICK_BUDGET) => {}
        }
    }
}
