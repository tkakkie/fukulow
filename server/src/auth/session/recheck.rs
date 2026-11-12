use super::*;
use sqlx::PgConnection;
use std::sync::Weak;

type CheckKey = (Uuid, Vec<u8>, i64);

const BATCH_SIZE: usize = 1000;
const EXIT_GRACE: Duration = Duration::from_secs(2);

impl SessionChanges {
    pub(super) fn start_rechecks(&self, pool: &PgPool) {
        self.worker.call_once(|| {
            let sessions = Arc::downgrade(&self.sessions);
            let pool = pool.clone();
            let interval = self.interval;
            let timeout = self.timeout;
            let subscriptions = self.subscriptions.clone();
            let worker = tokio::spawn(run(
                sessions.clone(),
                pool.clone(),
                interval,
                timeout,
                subscriptions,
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
    subscriptions: Arc<Mutex<Option<Arc<dyn SubscriptionRecheck>>>>,
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
        let check = subscriptions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(check) = check
            && (!matches!(
                tokio::time::timeout_at(bound, check.check(&pool, SubscriptionScope::All)).await,
                Ok(Ok(()))
            ) || Instant::now() >= bound)
        {
            check.failed(SubscriptionScope::All);
            for signal in sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .entries
                .values()
            {
                signal.send_modify(|status| status.failed = true);
            }
        }
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
        .filter(|(_, signal)| {
            !signal.borrow().revoked
                && !signal.borrow().membership_revoked
                && !signal.borrow().failed
        })
        .map(|(key, signal)| (key.clone(), signal.clone()))
        .collect();
    #[cfg(test)]
    super::tests::pause_gate(gate, super::tests::Phase::Snapshot).await;
    if snapshot.is_empty() {
        return;
    }
    let keys: Vec<_> = snapshot
        .iter()
        .map(|(key, signal)| (key.0, key.1.clone(), signal.borrow().membership_revision))
        .collect();
    let result = check(pool, &keys, bound).await;
    #[cfg(test)]
    super::tests::pause_gate(gate, super::tests::Phase::Queried).await;
    for (key, signal) in &snapshot {
        if Instant::now() >= bound {
            for (_, signal) in &snapshot {
                signal.send_modify(|status| status.failed = true);
            }
            return;
        }
        // Signal this registration epoch only: a disconnected/reconnected key may
        // have a new entry while SQL is in flight. Never clear either latch.
        match &result {
            Ok(ended) => match ended.get(key) {
                Some(4001) => signal.send_modify(|status| status.revoked = true),
                Some(4003) => signal.send_modify(|status| status.membership_revoked = true),
                _ => {}
            },
            Err(_) => signal.send_modify(|status| status.failed = true),
        }
    }
    if Instant::now() >= bound {
        for (_, signal) in &snapshot {
            signal.send_modify(|status| status.failed = true);
        }
    }
}

async fn check(
    pool: &PgPool,
    keys: &[CheckKey],
    bound: Instant,
) -> Result<HashMap<SessionKey, u16>, sqlx::Error> {
    tokio::time::timeout_at(bound, async {
        let mut ended = HashMap::new();
        let mut groups = std::collections::BTreeMap::<_, Vec<_>>::new();
        for key in keys {
            groups.entry(key.0).or_default().push(key.clone());
        }
        for (organization, keys) in groups {
            ended.extend(
                crate::database::organization_read_only_detached(
                    pool,
                    organization,
                    async |tx: &mut PgConnection| query(tx, &keys).await,
                )
                .await?,
            );
        }
        Ok(ended)
    })
    .await
    .map_err(|_| sqlx::Error::PoolTimedOut)?
}

async fn query(
    connection: &mut PgConnection,
    keys: &[CheckKey],
) -> Result<HashMap<SessionKey, u16>, sqlx::Error> {
    let mut ended = HashMap::new();
    for batch in keys.chunks(BATCH_SIZE) {
        let organizations: Vec<_> = batch.iter().map(|key| key.0).collect();
        let hashes: Vec<_> = batch.iter().map(|key| key.1.clone()).collect();
        let revisions: Vec<_> = batch.iter().map(|key| key.2).collect();
        // Start from registered keys and preserve missing session versus membership
        // causes. An INNER JOIN would collapse these independent revocations.
        let rows = sqlx::query_as::<_, (Uuid, Vec<u8>, i32)>(
            "SELECT registered.organization_id, registered.token_hash, \
             CASE WHEN s.token_hash IS NULL OR s.expires_at <= clock_timestamp() THEN 4001 \
                  WHEN u.id IS NULL OR u.deactivated_at IS NOT NULL OR u.membership_revision != registered.revision THEN 4003 \
                  ELSE 0 END \
             FROM unnest($1::uuid[], $2::bytea[], $3::bigint[]) AS registered(organization_id, token_hash, revision) \
             LEFT JOIN account_sessions s ON s.token_hash = registered.token_hash \
             LEFT JOIN users u ON u.organization_id = registered.organization_id AND u.account_id = s.account_id"
        ).bind(organizations).bind(hashes).bind(revisions).fetch_all(&mut *connection).await?;
        for (organization, hash, code) in rows {
            if code == 4001 {
                ended.insert((organization, hash), 4001);
            } else if code == 4003 {
                ended.insert((organization, hash), 4003);
            }
        }
    }
    Ok(ended)
}

#[cfg(test)]
mod tests;
