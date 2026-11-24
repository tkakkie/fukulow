//! All application pool entry points route here, including formerly implicit
//! executors. Owner commands and SQLx's initial connect are deliberately separate.
use sqlx::{PgPool, Postgres, Transaction, pool::PoolConnection};
use std::{
    sync::{
        LazyLock,
        atomic::{AtomicU64, Ordering::Relaxed},
    },
    time::{Duration, Instant},
};

const INTERVAL: Duration = Duration::from_secs(1);
const WAIT_US: &[u64] = &[
    100,
    500,
    1_000,
    5_000,
    10_000,
    25_000,
    50_000,
    100_000,
    500_000,
    1_000_000,
    5_000_000,
    u64::MAX,
];
const ACTIVE: &[u64] = &[0, 1, 2, 4, 8, 16, 24, 32, 48, 64, 100, u64::MAX];
static STATS: LazyLock<Stats> = LazyLock::new(Stats::new);

pub(crate) async fn acquire(pool: &PgPool) -> Result<PoolConnection<Postgres>, sqlx::Error> {
    #[cfg(test)]
    if let Ok(stats) = TEST_STATS.try_with(std::sync::Arc::clone) {
        return stats.acquire(pool).await;
    }
    STATS.acquire(pool).await
}

pub(crate) async fn begin(pool: &PgPool) -> Result<Transaction<'static, Postgres>, sqlx::Error> {
    // Transfer ownership to SQLx so its normal transaction rollback-on-drop stays intact.
    Transaction::begin(acquire(pool).await?, None).await
}

struct Histogram(Box<[AtomicU64]>);
impl Histogram {
    fn new(edges: &[u64]) -> Self {
        Self(edges.iter().map(|_| AtomicU64::new(0)).collect())
    }
    fn record(&self, edges: &[u64], value: u64) {
        let bucket = edges.partition_point(|edge| *edge < value);
        self.0[bucket].fetch_add(1, Relaxed);
    }
    fn cumulative(&self) -> Vec<u64> {
        let mut sum = 0;
        self.0
            .iter()
            .map(|count| {
                sum += count.load(Relaxed);
                sum
            })
            .collect()
    }
}

struct Stats {
    wait: Histogram,
    occupancy: Histogram,
    success: AtomicU64,
    timeout: AtomicU64,
    closed: AtomicU64,
    io: AtomicU64,
    database: AtomicU64,
    other: AtomicU64,
    cancelled: AtomicU64,
    waiting: AtomicU64,
}
impl Stats {
    fn new() -> Self {
        Self {
            wait: Histogram::new(WAIT_US),
            occupancy: Histogram::new(ACTIVE),
            success: AtomicU64::new(0),
            timeout: AtomicU64::new(0),
            closed: AtomicU64::new(0),
            io: AtomicU64::new(0),
            database: AtomicU64::new(0),
            other: AtomicU64::new(0),
            cancelled: AtomicU64::new(0),
            waiting: AtomicU64::new(0),
        }
    }
    async fn acquire(&self, pool: &PgPool) -> Result<PoolConnection<Postgres>, sqlx::Error> {
        self.waiting.fetch_add(1, Relaxed);
        let mut guard = Wait {
            stats: self,
            start: Instant::now(),
            completed: false,
        };
        let result = pool.acquire().await;
        let counter = match &result {
            Ok(_) => &self.success,
            Err(sqlx::Error::PoolTimedOut) => &self.timeout,
            Err(sqlx::Error::PoolClosed) => &self.closed,
            Err(sqlx::Error::Io(_)) => &self.io,
            Err(sqlx::Error::Database(_)) => &self.database,
            Err(_) => &self.other,
        };
        counter.fetch_add(1, Relaxed);
        guard.completed = true;
        result
    }
    fn sample(&self, pool: &PgPool) -> (u64, u64) {
        // SQLx exposes these independently; returning connections and maintenance
        // may race the reads. Saturation avoids underflow without acquiring a lock.
        let size = u64::from(pool.size());
        let idle = (pool.num_idle() as u64).min(size);
        let active = size - idle;
        self.occupancy.record(ACTIVE, active);
        (active, idle)
    }
    fn report(&self, active: u64, idle: u64, sequence: u64, elapsed: Duration) {
        let w = self.wait.cumulative();
        let o = self.occupancy.cumulative();
        // A root span prevents request context from being attached to aggregate logs.
        let span = tracing::info_span!(target: "fukulow", parent: None, "aggregates");
        let _entered = span.enter();
        tracing::info!(target: "fukulow", parent: None,
            event = "pool_stats", version = 1, coverage = "application_after_connect",
            uncovered_paths = "startup_connect,migration_commands", interval_ms = 1000,
            sample_sequence = sequence, sample_elapsed_ms = elapsed.as_millis() as u64,
            in_use = active, idle, waiting = self.waiting.load(Relaxed),
            acquire_success = self.success.load(Relaxed), acquire_timeout = self.timeout.load(Relaxed),
            acquire_closed = self.closed.load(Relaxed), acquire_io = self.io.load(Relaxed),
            acquire_database = self.database.load(Relaxed), acquire_other = self.other.load(Relaxed),
            acquire_cancelled = self.cancelled.load(Relaxed),
            wait_le_100_us = w[0], wait_le_500_us = w[1], wait_le_1000_us = w[2],
            wait_le_5000_us = w[3], wait_le_10000_us = w[4], wait_le_25000_us = w[5],
            wait_le_50000_us = w[6], wait_le_100000_us = w[7], wait_le_500000_us = w[8],
            wait_le_1000000_us = w[9], wait_le_5000000_us = w[10], wait_count = w[11],
            occupancy_le_0 = o[0], occupancy_le_1 = o[1], occupancy_le_2 = o[2],
            occupancy_le_4 = o[3], occupancy_le_8 = o[4], occupancy_le_16 = o[5],
            occupancy_le_24 = o[6], occupancy_le_32 = o[7], occupancy_le_48 = o[8],
            occupancy_le_64 = o[9], occupancy_le_100 = o[10], occupancy_count = o[11]);
    }
}

struct Wait<'a> {
    stats: &'a Stats,
    start: Instant,
    completed: bool,
}
impl Drop for Wait<'_> {
    fn drop(&mut self) {
        self.stats
            .wait
            .record(WAIT_US, wait_us(self.start.elapsed()));
        if !self.completed {
            self.stats.cancelled.fetch_add(1, Relaxed);
        }
        self.stats.waiting.fetch_sub(1, Relaxed);
    }
}

pub async fn report_pool_periodically(pool: PgPool) {
    #[cfg(test)]
    if let Ok(stats) = TEST_STATS.try_with(std::sync::Arc::clone) {
        return report(&stats, &pool).await;
    }
    report(&STATS, &pool).await;
}

async fn report(stats: &Stats, pool: &PgPool) {
    let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + INTERVAL, INTERVAL);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last = tokio::time::Instant::now();
    let mut sequence = 0;
    loop {
        ticks.tick().await;
        let now = tokio::time::Instant::now();
        let (active, idle) = stats.sample(pool);
        sequence += 1;
        stats.report(active, idle, sequence, now - last);
        last = now;
    }
}

fn wait_us(elapsed: Duration) -> u64 {
    (elapsed.as_nanos().saturating_add(999) / 1000).min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
tokio::task_local! {
    static TEST_STATS: std::sync::Arc<Stats>;
}

#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) async fn test_acquisitions<T>(body: impl std::future::Future<Output = T>) -> (T, u64) {
    let stats = std::sync::Arc::new(Stats::new());
    let result = TEST_STATS.scope(stats.clone(), body).await;
    assert_eq!(stats.waiting.load(Relaxed), 0);
    (result, stats.success.load(Relaxed))
}

// Capture before spawning: Tokio task-local values are not inherited by child tasks.
#[cfg(test)]
pub(crate) fn test_inherit_acquisitions<T>(
    body: impl std::future::Future<Output = T>,
) -> impl std::future::Future<Output = T> {
    let stats = TEST_STATS.try_with(std::sync::Arc::clone).ok();
    async move {
        match stats {
            Some(stats) => TEST_STATS.scope(stats, body).await,
            None => body.await,
        }
    }
}
