use super::Auth;
use crate::AppState;
use sqlx::PgPool;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, Once},
    time::Duration,
};
use tokio::{sync::watch, time::Instant};
use uuid::Uuid;

const RECHECK_INTERVAL: Duration = Duration::from_secs(30);
const CHECK_TIMEOUT: Duration = Duration::from_secs(5);
pub trait SubscriptionRecheck: Send + Sync {
    fn check<'a>(
        &'a self,
        pool: &'a PgPool,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), sqlx::Error>> + Send + 'a>>;
    fn failed(&self);
}

type SessionKey = (Uuid, Vec<u8>);

#[derive(Clone, Copy, Default)]
struct SessionStatus {
    revoked: bool,
    failed: bool,
    membership_revoked: bool,
    account_id: Uuid,
    membership_revision: i64,
}

#[derive(Default)]
struct Sessions {
    entries: HashMap<SessionKey, watch::Sender<SessionStatus>>,
    by_token: HashMap<Vec<u8>, HashSet<SessionKey>>,
    by_member: HashMap<(Uuid, Uuid), HashSet<SessionKey>>,
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
    subscriptions: Arc<Mutex<Option<Arc<dyn SubscriptionRecheck>>>>,
    #[cfg(test)]
    default_fatal_calls: Option<Arc<std::sync::atomic::AtomicUsize>>,
    #[cfg(test)]
    gate: Arc<Mutex<Option<Arc<tests::Gate>>>>,
}
impl Default for SessionChanges {
    fn default() -> Self {
        #[cfg(test)]
        let default_fatal_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        Self {
            subscriptions: Default::default(),
            sessions: Default::default(),
            worker: Arc::new(Once::new()),
            interval: RECHECK_INTERVAL,
            timeout: CHECK_TIMEOUT,
            #[cfg(not(test))]
            on_fatal: Arc::new(|| std::process::exit(1)),
            #[cfg(test)]
            on_fatal: {
                let calls = default_fatal_calls.clone();
                Arc::new(move || {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                })
            },
            #[cfg(test)]
            default_fatal_calls: Some(default_fatal_calls),
            #[cfg(test)]
            gate: Default::default(),
        }
    }
}

impl SessionChanges {
    pub fn set_subscription_recheck(&self, check: Arc<dyn SubscriptionRecheck>) {
        *self.subscriptions.lock().unwrap_or_else(|e| e.into_inner()) = Some(check);
    }

    pub(crate) async fn recheck_subscriptions(&self, pool: &PgPool) {
        let check = self
            .subscriptions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(check) = check
            && !matches!(
                tokio::time::timeout(CHECK_TIMEOUT, check.check(pool)).await,
                Ok(Ok(()))
            )
        {
            check.failed();
        }
    }

    #[cfg(test)]
    fn register(&self, key: SessionKey) -> Registration {
        self.register_member(key, Uuid::nil(), 0)
    }

    fn register_member(
        &self,
        key: SessionKey,
        account_id: Uuid,
        membership_revision: i64,
    ) -> Registration {
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let unavailable = sessions.unavailable;
        let signal = sessions.entries.entry(key.clone()).or_insert_with(|| {
            watch::channel(SessionStatus {
                account_id,
                membership_revision,
                ..SessionStatus::default()
            })
            .0
        });
        let status = *signal.borrow();
        if !status.revoked
            && status.account_id == account_id
            && membership_revision < status.membership_revision
        {
            // An upgrade authorized before reactivation must not replace or
            // revoke an epoch authorized against the newer Membership.
            let epoch = watch::channel(SessionStatus {
                account_id,
                membership_revision,
                membership_revoked: true,
                failed: unavailable,
                ..SessionStatus::default()
            })
            .0;
            return Registration {
                changed: epoch.subscribe(),
                guard: RegistrationGuard {
                    registry: self.clone(),
                    key,
                    epoch,
                },
            };
        }
        if !status.revoked
            && ((status.failed && !status.membership_revoked)
                || status.account_id != account_id
                || status.membership_revision != membership_revision)
        {
            // Old sockets and in-flight passes keep their original sender.
            if status.account_id != account_id || status.membership_revision != membership_revision
            {
                signal.send_modify(|status| status.membership_revoked = true);
            }
            *signal = watch::channel(SessionStatus {
                account_id,
                membership_revision,
                ..SessionStatus::default()
            })
            .0;
        }
        if unavailable {
            signal.send_modify(|status| status.failed = true);
        }
        let epoch = signal.clone();
        let changed = signal.subscribe();
        let account_id = signal.borrow().account_id;
        if status.account_id != account_id {
            remove_index(&mut sessions.by_member, &(key.0, status.account_id), &key);
        }
        sessions
            .by_token
            .entry(key.1.clone())
            .or_default()
            .insert(key.clone());
        sessions
            .by_member
            .entry((key.0, account_id))
            .or_default()
            .insert(key.clone());
        Registration {
            changed,
            guard: RegistrationGuard {
                registry: self.clone(),
                key,
                epoch,
            },
        }
    }

    pub(super) fn revoked(&self, hash: Vec<u8>) {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(keys) = sessions.by_token.get(&hash) {
            for key in keys {
                if let Some(signal) = sessions.entries.get(key) {
                    signal.send_modify(|status| status.revoked = true);
                }
            }
        }
    }
    pub(super) fn membership_revoked(&self, organization: Uuid, account_id: Uuid, revision: i64) {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(keys) = sessions.by_member.get(&(organization, account_id)) {
            for key in keys {
                if let Some(signal) = sessions.entries.get(key)
                    && signal.borrow().membership_revision < revision
                {
                    signal.send_modify(|status| status.membership_revoked = true);
                }
            }
        }
    }
}

fn remove_index<K: Eq + std::hash::Hash>(
    index: &mut HashMap<K, HashSet<SessionKey>>,
    key: &K,
    session: &SessionKey,
) {
    if let Some(entries) = index.get_mut(key) {
        entries.remove(session);
        if entries.is_empty() {
            index.remove(key);
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
            let account_id = self.epoch.borrow().account_id;
            sessions.entries.remove(&self.key);
            remove_index(&mut sessions.by_token, &self.key.1, &self.key);
            remove_index(
                &mut sessions.by_member,
                &(self.key.0, account_id),
                &self.key,
            );
        }
    }
}
pub(crate) struct SessionWatch {
    registration: Registration,
    deadline: Option<Instant>,
}

async fn deadline(
    pool: &PgPool,
    key: &SessionKey,
    account: Uuid,
    revision: i64,
) -> Result<(Option<Instant>, bool), sqlx::Error> {
    let checked_at = Instant::now();
    let row = tokio::time::timeout(CHECK_TIMEOUT, sqlx::query_as::<_, (f64, bool)>(
        "SELECT EXTRACT(EPOCH FROM (s.expires_at - clock_timestamp()))::float8, \
         COALESCE(u.deactivated_at IS NULL AND u.membership_revision = $4 AND u.account_id = $3, false) \
         FROM account_sessions s LEFT JOIN users u ON u.account_id = s.account_id AND u.organization_id = $1 \
         WHERE s.token_hash = $2 AND s.expires_at > clock_timestamp()"
    ).bind(key.0).bind(&key.1).bind(account).bind(revision).fetch_optional(pool)).await.map_err(|_| sqlx::Error::PoolTimedOut)??;
    Ok(match row {
        Some((seconds, active)) if seconds.is_finite() && seconds > 0.0 => (
            Some(
                checked_at
                    + Duration::from_secs_f64(seconds.min(f64::from(super::SESSION_SECONDS))),
            ),
            active,
        ),
        _ => (None, false),
    })
}

impl Auth {
    /// Register revocation before checking SQL, so sign-out during upgrade cannot be missed.
    pub(crate) async fn watch_session(
        &self,
        state: &AppState,
    ) -> Result<Option<SessionWatch>, sqlx::Error> {
        state.session_changes.start_rechecks(&state.pool);
        let registration = state.session_changes.register_member(
            (
                self.identity.organization.organization_id,
                self.token_hash.clone(),
            ),
            self.account_id,
            self.membership_revision,
        );
        let status = *registration.changed.borrow();
        if status.revoked {
            return Ok(None);
        }
        if status.membership_revoked {
            return Ok(Some(SessionWatch {
                registration,
                deadline: None,
            }));
        }
        if status.failed {
            return Err(sqlx::Error::PoolClosed);
        }
        #[cfg(test)]
        state
            .session_changes
            .pause_check(tests::Phase::Registered)
            .await;
        let checked = deadline(
            &state.pool,
            &registration.guard.key,
            self.account_id,
            self.membership_revision,
        )
        .await;
        if matches!(checked, Ok((Some(_), false))) {
            registration
                .guard
                .epoch
                .send_modify(|status| status.membership_revoked = true);
        }
        #[cfg(test)]
        state
            .session_changes
            .pause_check(tests::Phase::Checked)
            .await;
        let status = *registration.changed.borrow();
        if status.revoked {
            return Ok(None);
        }
        if status.membership_revoked {
            return Ok(Some(SessionWatch {
                registration,
                deadline: checked.as_ref().ok().and_then(|(deadline, _)| *deadline),
            }));
        }
        if status.failed {
            return Err(sqlx::Error::PoolClosed);
        }
        Ok(checked?.0.map(|deadline| SessionWatch {
            registration,
            deadline: Some(deadline),
        }))
    }
}

impl SessionWatch {
    pub(crate) async fn ended(&mut self) -> Result<u16, sqlx::Error> {
        tokio::select! {
            biased;
            _ = async {
                match self.deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending().await,
                }
            } => Ok(4001),
            status = self.registration.changed.wait_for(|status| status.revoked || status.membership_revoked || status.failed) => {
                match status {
                    Ok(status) if status.revoked => Ok(4001),
                    Ok(status) if status.membership_revoked => Ok(4003),
                    _ => Err(sqlx::Error::PoolTimedOut),
                }
            }
        }
    }
}

mod recheck;

#[cfg(test)]
mod tests;
