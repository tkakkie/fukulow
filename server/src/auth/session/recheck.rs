use super::*;
use sqlx::PgConnection;
use std::{collections::HashSet, sync::Weak};

const BATCH_SIZE: usize = 1000;
const EXIT_GRACE: Duration = Duration::from_secs(2);

impl SessionChanges {
    pub(super) fn start_rechecks(&self, pool: &PgPool) {
        self.worker.call_once(|| {
            let sessions = Arc::downgrade(&self.sessions);
            let pool = pool.clone();
            let interval = self.interval;
            let timeout = self.timeout;
            let worker = tokio::spawn(run(
                sessions.clone(),
                pool.clone(),
                interval,
                timeout,
                #[cfg(test)]
                self.gate.clone(),
            ));
            tokio::spawn(supervise(worker, sessions, pool, self.on_fatal.clone()));
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

    #[cfg(test)]
    pub(crate) fn with_on_fatal(mut self, on_fatal: Arc<dyn Fn() + Send + Sync>) -> Self {
        self.assert_no_default_fatal();
        self.on_fatal = on_fatal;
        self.default_fatal_calls = None;
        self
    }
}

async fn supervise(
    worker: tokio::task::JoinHandle<()>,
    sessions: Weak<Mutex<Sessions>>,
    pool: PgPool,
    on_fatal: Arc<dyn Fn() + Send + Sync>,
) {
    let result = worker.await;
    let sessions = sessions.upgrade();
    // A panic/cancellation is never a clean shutdown, even if teardown races it.
    let abnormal = result.is_err() || (sessions.is_some() && !pool.is_closed());
    if let Some(sessions) = sessions {
        // Admission and failure signalling share the registration lock.
        let mut sessions = sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.unavailable = true;
        for signal in sessions.entries.values() {
            signal.send_modify(|status| status.failed = true);
        }
        eprintln!("session fallback worker stopped; WebSockets fail closed: {result:?}");
    }
    if abnormal {
        // Do not wait on sockets: a stuck Close frame must not prevent recovery.
        tokio::time::sleep(EXIT_GRACE).await;
        on_fatal();
    }
}

async fn run(
    sessions: Weak<Mutex<Sessions>>,
    pool: PgPool,
    interval: Duration,
    timeout: Duration,
    #[cfg(test)] gate: Arc<Mutex<Option<Arc<super::tests::Gate>>>>,
) {
    let mut ticks = tokio::time::interval_at(Instant::now() + interval, interval);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    #[cfg(test)]
    super::tests::pause_gate(&gate, super::tests::Phase::Started).await;
    loop {
        let closed = tokio::select! {
            _ = pool.close_event() => true,
            _ = ticks.tick() => false,
        };
        let Some(sessions) = sessions.upgrade() else {
            return;
        };
        let bound = Instant::now() + timeout;
        #[cfg(test)]
        super::tests::pause_gate(&gate, super::tests::Phase::Worker).await;
        pass(
            &sessions,
            &pool,
            bound,
            #[cfg(test)]
            &gate,
        )
        .await;
        if closed {
            return;
        }
    }
}

async fn pass(
    sessions: &Mutex<Sessions>,
    pool: &PgPool,
    bound: Instant,
    #[cfg(test)] gate: &Mutex<Option<Arc<super::tests::Gate>>>,
) {
    let snapshot: Vec<_> = sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entries
        .iter()
        .filter(|(_, signal)| !signal.borrow().revoked && !signal.borrow().failed)
        .map(|(key, signal)| (key.clone(), signal.clone()))
        .collect();
    #[cfg(test)]
    super::tests::pause_gate(gate, super::tests::Phase::Snapshot).await;
    if snapshot.is_empty() {
        return;
    }
    let keys: Vec<_> = snapshot.iter().map(|(key, _)| key.clone()).collect();
    let result = check(pool, &keys, bound).await;
    #[cfg(test)]
    super::tests::pause_gate(gate, super::tests::Phase::Queried).await;
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
}

async fn check(
    pool: &PgPool,
    keys: &[SessionKey],
    bound: Instant,
) -> Result<HashSet<SessionKey>, sqlx::Error> {
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
