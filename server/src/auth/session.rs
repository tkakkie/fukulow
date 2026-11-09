use super::Auth;
use crate::AppState;
use sqlx::PgPool;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::watch, time::Instant};
use uuid::Uuid;

const RECHECK_INTERVAL: Duration = Duration::from_secs(30);
const CHECK_TIMEOUT: Duration = Duration::from_secs(5);
type SessionKey = (Uuid, Vec<u8>);

/// Only connected sessions retain a signal; sign-out never wakes unrelated sessions.
#[derive(Clone, Default)]
pub struct SessionChanges {
    sessions: Arc<Mutex<HashMap<SessionKey, watch::Sender<bool>>>>,
    #[cfg(test)]
    gate: Arc<Mutex<Option<Arc<tests::Gate>>>>,
}
impl SessionChanges {
    fn register(&self, key: SessionKey) -> Registration {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let changed = sessions
            .entry(key.clone())
            .or_insert_with(|| watch::channel(false).0)
            .subscribe();
        Registration {
            changed,
            guard: RegistrationGuard {
                registry: self.clone(),
                key,
            },
        }
    }

    pub(super) fn revoked(&self, organization: Uuid, hash: Vec<u8>) {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(signal) = sessions.get(&(organization, hash)) {
            signal.send_replace(true);
        }
    }
}

struct Registration {
    // Drop the receiver before checking for last-socket cleanup, including concurrent drops.
    changed: watch::Receiver<bool>,
    guard: RegistrationGuard,
}
struct RegistrationGuard {
    registry: SessionChanges,
    key: SessionKey,
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
            .get(&self.key)
            .is_some_and(|signal| signal.receiver_count() == 0)
        {
            sessions.remove(&self.key);
        }
    }
}
pub(crate) struct SessionWatch {
    registration: Registration,
    pool: PgPool,
    deadline: Instant,
    next_check: Instant,
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
        let registration = state.session_changes.register((
            self.identity.organization.organization_id,
            self.token_hash.clone(),
        ));
        #[cfg(test)]
        state
            .session_changes
            .pause_check(tests::Phase::Registered)
            .await;
        let next_check = Instant::now() + RECHECK_INTERVAL;
        let deadline = deadline(&state.pool, &registration.guard.key).await?;
        #[cfg(test)]
        state
            .session_changes
            .pause_check(tests::Phase::Checked)
            .await;
        Ok(deadline.map(|deadline| SessionWatch {
            registration,
            pool: state.pool.clone(),
            deadline,
            next_check,
        }))
    }
}

impl SessionWatch {
    pub(crate) async fn ended(&mut self) -> Result<(), sqlx::Error> {
        loop {
            tokio::select! {
                biased;
                _ = tokio::time::sleep_until(self.deadline) => return Ok(()),
                _ = self.registration.changed.wait_for(|revoked| *revoked) => return Ok(()),
                result = async {
                    tokio::time::sleep_until(self.next_check).await;
                    let next_check = Instant::now() + RECHECK_INTERVAL;
                    (next_check, deadline(&self.pool, &self.registration.guard.key).await)
                } => {
                    let (next_check, result) = result;
                    let Some(deadline) = result? else { return Ok(()) };
                    self.deadline = self.deadline.min(deadline);
                    self.next_check = next_check;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
