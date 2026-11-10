use super::*;
use sqlx::PgConnection;
use std::{collections::HashSet, sync::Weak};

type Sessions = Mutex<HashMap<SessionKey, watch::Sender<SessionStatus>>>;
const BATCH_SIZE: usize = 1000;

impl SessionChanges {
    pub(super) fn start_rechecks(&self, pool: &PgPool) {
        self.worker.call_once(|| {
            let sessions = Arc::downgrade(&self.sessions);
            let pool = pool.clone();
            let interval = self.interval;
            let timeout = self.timeout;
            tokio::spawn(run(sessions, pool, interval, timeout));
        });
    }

    #[cfg(test)]
    pub(crate) fn with_recheck_timing(interval: Duration, timeout: Duration) -> Self {
        Self {
            interval,
            timeout,
            ..Self::default()
        }
    }
}

async fn run(sessions: Weak<Sessions>, pool: PgPool, interval: Duration, timeout: Duration) {
    let mut ticks = tokio::time::interval_at(Instant::now() + interval, interval);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        let closed = tokio::select! {
            _ = pool.close_event() => true,
            _ = ticks.tick() => false,
        };
        let Some(sessions) = sessions.upgrade() else {
            return;
        };
        let snapshot: Vec<_> = sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|(_, signal)| !signal.borrow().revoked && !signal.borrow().failed)
            .map(|(key, signal)| (key.clone(), signal.clone()))
            .collect();
        if snapshot.is_empty() {
            if closed {
                return;
            }
            continue;
        }
        let keys: Vec<_> = snapshot.iter().map(|(key, _)| key.clone()).collect();
        let result = if closed {
            Err(sqlx::Error::PoolClosed)
        } else {
            check(&pool, &keys, timeout).await
        };
        for (key, signal) in snapshot {
            // Signal this registration epoch only: a disconnected/reconnected key may
            // have a new entry while SQL is in flight. Never clear either latch.
            match &result {
                Ok(present) if !present.contains(&key) => {
                    signal.send_modify(|status| status.revoked = true);
                }
                Err(_) => signal.send_modify(|status| status.failed = true),
                _ => {}
            }
        }
        if closed {
            return;
        }
    }
}

async fn check(
    pool: &PgPool,
    keys: &[SessionKey],
    timeout: Duration,
) -> Result<HashSet<SessionKey>, sqlx::Error> {
    let bound = Instant::now() + timeout;
    let mut connection = tokio::time::timeout_at(bound, pool.acquire())
        .await
        .map_err(|_| sqlx::Error::PoolTimedOut)??;
    match tokio::time::timeout_at(bound, query(&mut connection, keys)).await {
        Ok(result) => result,
        Err(_) => {
            // Release the pool slot and drop the socket immediately: graceful
            // close-on-drop retains its permit until asynchronous cleanup finishes.
            drop(connection.detach());
            Err(sqlx::Error::PoolTimedOut)
        }
    }
}

async fn query(
    connection: &mut PgConnection,
    keys: &[SessionKey],
) -> Result<HashSet<SessionKey>, sqlx::Error> {
    let mut present = HashSet::new();
    for batch in keys.chunks(BATCH_SIZE) {
        let organizations: Vec<_> = batch.iter().map(|key| key.0).collect();
        let hashes: Vec<_> = batch.iter().map(|key| key.1.clone()).collect();
        present.extend(
            sqlx::query_as::<_, SessionKey>(
                "SELECT sessions.organization_id, sessions.token_hash FROM sessions \
             JOIN unnest($1::uuid[], $2::bytea[]) AS registered(organization_id, token_hash) \
             USING (organization_id, token_hash) WHERE expires_at > clock_timestamp()",
            )
            .bind(organizations)
            .bind(hashes)
            .fetch_all(&mut *connection)
            .await?,
        );
    }
    Ok(present)
}

#[cfg(test)]
mod tests;
