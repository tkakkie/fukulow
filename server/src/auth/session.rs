use super::Auth;
use crate::AppState;
use sqlx::PgPool;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Once},
    time::Duration,
};
use tokio::{sync::watch, time::Instant};
use uuid::Uuid;

const RECHECK_INTERVAL: Duration = Duration::from_secs(30);
const CHECK_TIMEOUT: Duration = Duration::from_secs(5);
type SessionKey = (Uuid, Vec<u8>);

#[derive(Clone, Copy, Default)]
struct SessionStatus {
    revoked: bool,
    failed: bool,
}

#[derive(Default)]
struct Sessions {
    entries: HashMap<SessionKey, watch::Sender<SessionStatus>>,
    unavailable: bool,
}

/// Only connected sessions retain a signal; sign-out never wakes unrelated sessions.
#[derive(Clone)]
pub struct SessionChanges {
    sessions: Arc<Mutex<Sessions>>,
    worker: Arc<Once>,
    interval: Duration,
    timeout: Duration,
    on_fatal: Arc<dyn Fn() + Send + Sync>,
    #[cfg(test)]
    gate: Arc<Mutex<Option<Arc<tests::Gate>>>>,
}
impl Default for SessionChanges {
    fn default() -> Self {
        Self {
            sessions: Default::default(),
            worker: Arc::new(Once::new()),
            interval: RECHECK_INTERVAL,
            timeout: CHECK_TIMEOUT,
            on_fatal: Arc::new(|| std::process::exit(1)),
            #[cfg(test)]
            gate: Default::default(),
        }
    }
}

impl SessionChanges {
    fn register(&self, key: SessionKey) -> Registration {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let unavailable = sessions.unavailable;
        let signal = sessions
            .entries
            .entry(key.clone())
            .or_insert_with(|| watch::channel(SessionStatus::default()).0);
        let status = *signal.borrow();
        if status.failed && !status.revoked {
            // Old sockets and in-flight passes keep their original sender.
            *signal = watch::channel(SessionStatus::default()).0;
        }
        if unavailable {
            signal.send_modify(|status| status.failed = true);
        }
        Registration {
            changed: signal.subscribe(),
            guard: RegistrationGuard {
                registry: self.clone(),
                key,
                epoch: signal.clone(),
            },
        }
    }

    pub(super) fn revoked(&self, organization: Uuid, hash: Vec<u8>) {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(signal) = sessions.entries.get(&(organization, hash)) {
            signal.send_modify(|status| status.revoked = true);
        }
    }
}

struct Registration {
    // Drop the receiver before checking for last-socket cleanup, including concurrent drops.
    changed: watch::Receiver<SessionStatus>,
    guard: RegistrationGuard,
}
struct RegistrationGuard {
    registry: SessionChanges,
    key: SessionKey,
    epoch: watch::Sender<SessionStatus>,
}
impl Drop for RegistrationGuard {
    fn drop(&mut self) {
        let mut sessions = self
            .registry
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Registration and last-receiver removal use the same lock as sign-out.
        if sessions
            .entries
            .get(&self.key)
            .is_some_and(|signal| signal.same_channel(&self.epoch) && signal.receiver_count() == 0)
        {
            sessions.entries.remove(&self.key);
        }
    }
}
pub(crate) struct SessionWatch {
    registration: Registration,
    deadline: Instant,
}

async fn deadline(pool: &PgPool, key: &SessionKey) -> Result<Option<Instant>, sqlx::Error> {
    let checked_at = Instant::now();
    let remaining = tokio::time::timeout(
        CHECK_TIMEOUT,
        sqlx::query_scalar::<_, f64>(
            "SELECT EXTRACT(EPOCH FROM (expires_at - clock_timestamp()))::float8 \
             FROM sessions WHERE organization_id = $1 AND token_hash = $2 AND expires_at > clock_timestamp()",
        ).bind(key.0).bind(&key.1).fetch_optional(pool),
    ).await.map_err(|_| sqlx::Error::PoolTimedOut)??;
    Ok(remaining
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .map(|seconds| {
            // Count SQL latency conservatively: never extend a session past its DB expiry.
            checked_at + Duration::from_secs_f64(seconds.min(f64::from(super::SESSION_SECONDS)))
        }))
}

impl Auth {
    /// Register revocation before checking SQL, so sign-out during upgrade cannot be missed.
    pub(crate) async fn watch_session(
        &self,
        state: &AppState,
    ) -> Result<Option<SessionWatch>, sqlx::Error> {
        state.session_changes.start_rechecks(&state.pool);
        let registration = state.session_changes.register((
            self.identity.organization.organization_id,
            self.token_hash.clone(),
        ));
        let status = *registration.changed.borrow();
        if status.revoked {
            return Ok(None);
        }
        if status.failed {
            return Err(sqlx::Error::PoolClosed);
        }
        #[cfg(test)]
        state
            .session_changes
            .pause_check(tests::Phase::Registered)
            .await;
        let deadline = deadline(&state.pool, &registration.guard.key).await?;
        #[cfg(test)]
        state
            .session_changes
            .pause_check(tests::Phase::Checked)
            .await;
        let status = *registration.changed.borrow();
        if status.revoked {
            return Ok(None);
        }
        if status.failed {
            return Err(sqlx::Error::PoolClosed);
        }
        Ok(deadline.map(|deadline| SessionWatch {
            registration,
            deadline,
        }))
    }
}

impl SessionWatch {
    pub(crate) async fn ended(&mut self) -> Result<(), sqlx::Error> {
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(self.deadline) => Ok(()),
            status = self.registration.changed.wait_for(|status| status.revoked || status.failed) => {
                match status {
                    Ok(status) if status.revoked => Ok(()),
                    _ => Err(sqlx::Error::PoolTimedOut),
                }
            }
        }
    }
}

mod recheck;

#[cfg(test)]
mod tests;
