use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use sqlx::PgPool;
use tokio::time::Instant;
use uuid::Uuid;

const INTERVAL: Duration = Duration::from_secs(60);
const DEADLINE: Duration = Duration::from_secs(2);
const BATCH_SIZE: i64 = 1_000;

/// At most one cleanup run per interval across all Organizations served by this process.
/// Each run cleans one Organization, chosen round-robin by id, in a spawned task.
#[derive(Clone, Default)]
pub struct SessionCleanup(Arc<Mutex<State>>);

// Constant size: one start time, one cursor id and one flag.
struct State {
    interval: Duration,
    last_start: Option<Instant>,
    cursor: Option<Uuid>,
    running: bool,
    #[cfg(test)]
    task: Option<tokio::task::JoinHandle<()>>,
    #[cfg(test)]
    started: usize,
}

impl Default for State {
    fn default() -> Self {
        Self {
            interval: INTERVAL,
            last_start: None,
            cursor: None,
            running: false,
            #[cfg(test)]
            task: None,
            #[cfg(test)]
            started: 0,
        }
    }
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// Single-flight guard: dropped when the task completes, fails, times out or is cancelled.
struct Running(Arc<Mutex<State>>);

impl Drop for Running {
    fn drop(&mut self) {
        lock(&self.0).running = false;
    }
}

impl SessionCleanup {
    /// Never waits for SQL: the start is reserved here, everything else runs in the task.
    pub(super) fn trigger(&self, pool: &PgPool) {
        {
            let mut state = lock(&self.0);
            let now = Instant::now();
            if state.running
                || state
                    .last_start
                    .is_some_and(|last| now.duration_since(last) < state.interval)
            {
                return;
            }
            // Reserve before spawning, so failed or cancelled runs also consume the interval.
            state.last_start = Some(now);
            state.running = true;
            #[cfg(test)]
            {
                state.started += 1;
            }
        }
        // Spawn without holding the lock: a task dropped at once releases the guard.
        let running = Running(self.0.clone());
        let pool = pool.clone();
        let task = tokio::spawn(async move {
            run(&running.0, &pool).await;
            drop(running);
        });
        #[cfg(test)]
        {
            lock(&self.0).task = Some(task);
        }
        #[cfg(not(test))]
        drop(task);
    }
}

async fn run(state: &Mutex<State>, pool: &PgPool) {
    let result = tokio::time::timeout(DEADLINE, async {
        let mut tx = pool.begin().await?;
        // Bound lock waits and SQL work as well as the number of deleted rows.
        sqlx::query("SET LOCAL statement_timeout = '1s'")
            .execute(&mut *tx)
            .await?;
        let cursor = lock(state).cursor;
        // Round-robin over all Organizations: the first id after the cursor, wrapping to
        // the smallest. Only the id is read; the deletion below stays Organization-scoped.
        let organization: Option<Uuid> = sqlx::query_scalar(
            "SELECT COALESCE(\
             (SELECT organization_id FROM organizations WHERE organization_id > $1 \
              ORDER BY organization_id LIMIT 1), \
             (SELECT organization_id FROM organizations ORDER BY organization_id LIMIT 1))",
        )
        .bind(cursor)
        .fetch_one(&mut *tx)
        .await?;
        let Some(organization) = organization else {
            return tx.commit().await;
        };
        // Advance before deleting: a failed, timed-out or cancelled delete still uses the turn.
        lock(state).cursor = Some(organization);
        sqlx::query(
            "DELETE FROM sessions WHERE organization_id = $1 AND token_hash IN (\
             SELECT token_hash FROM sessions \
             WHERE organization_id = $1 AND expires_at <= now() \
             ORDER BY expires_at, token_hash LIMIT $2 FOR UPDATE SKIP LOCKED)",
        )
        .bind(organization)
        .bind(BATCH_SIZE)
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    })
    .await;
    match result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("expired-session cleanup failed: {error}"),
        Err(error) => eprintln!("expired-session cleanup timed out: {error}"),
    }
}

#[cfg(test)]
impl SessionCleanup {
    pub(crate) fn with_interval(interval: Duration) -> Self {
        let cleanup = Self::default();
        lock(&cleanup.0).interval = interval;
        cleanup
    }

    /// Test-only handle: waits for the last started task (aborted tasks included).
    pub(crate) async fn finished(&self) {
        let task = lock(&self.0).task.take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }

    pub(crate) fn abort(&self) {
        if let Some(task) = &lock(&self.0).task {
            task.abort();
        }
    }

    pub(crate) fn started(&self) -> usize {
        lock(&self.0).started
    }

    pub(crate) fn running(&self) -> bool {
        lock(&self.0).running
    }
}

#[cfg(test)]
mod tests;
