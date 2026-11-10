use std::{
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use sqlx::PgPool;
use tokio::time::Instant;

const INTERVAL: Duration = Duration::from_secs(60);
const DEADLINE: Duration = Duration::from_secs(2);
const BATCH_SIZE: i64 = 1_000;

/// At most one bounded global Account Session cleanup per interval, in a spawned task.
#[derive(Clone, Default)]
pub struct SessionCleanup(Arc<Mutex<State>>);

// Constant size: one start time and one flag.
struct State {
    interval: Duration,
    last_start: Option<Instant>,
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
            run(&pool).await;
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

async fn run(pool: &PgPool) {
    let result = tokio::time::timeout(DEADLINE, async {
        let mut tx = pool.begin().await?;
        // Bound lock waits and SQL work as well as the number of deleted rows.
        sqlx::query("SET LOCAL statement_timeout = '1s'")
            .execute(&mut *tx)
            .await?;
        // Account Sessions are global: deletion is bounded independently of
        // Organization membership and never deletes an active credential.
        sqlx::query(
            "DELETE FROM account_sessions WHERE token_hash IN (\
             SELECT token_hash FROM account_sessions WHERE expires_at <= now() \
             ORDER BY expires_at, token_hash LIMIT $1 FOR UPDATE SKIP LOCKED)",
        )
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
