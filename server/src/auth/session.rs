use super::Auth;
use crate::AppState;
use std::time::Duration;
use tokio::{sync::broadcast, time::Instant};
use uuid::Uuid;

/// Wake open connections immediately after sign-out commits. Only credential hashes are retained.
#[derive(Clone)]
pub struct SessionChanges(broadcast::Sender<(Uuid, Vec<u8>)>);
impl Default for SessionChanges {
    fn default() -> Self {
        Self(broadcast::channel(1024).0)
    }
}
impl SessionChanges {
    pub(super) fn revoked(&self, organization: Uuid, hash: Vec<u8>) {
        let _ = self.0.send((organization, hash));
    }
}

pub(crate) struct SessionWatch {
    changes: broadcast::Receiver<(Uuid, Vec<u8>)>,
    organization: Uuid,
    hash: Vec<u8>,
    deadline: Instant,
}

impl Auth {
    /// Register revocation before checking SQL, so sign-out during upgrade cannot be missed.
    pub(crate) async fn watch_session(&self, state: &AppState) -> Option<SessionWatch> {
        let changes = state.session_changes.0.subscribe();
        let organization = self.identity.organization.organization_id;
        let checked_at = Instant::now();
        let remaining = sqlx::query_scalar::<_, f64>(
            "SELECT EXTRACT(EPOCH FROM (expires_at - clock_timestamp()))::float8 \
             FROM sessions WHERE organization_id = $1 AND token_hash = $2 AND expires_at > clock_timestamp()",
        ).bind(organization).bind(&self.token_hash).fetch_optional(&state.pool).await;
        let Ok(Some(seconds)) = remaining else {
            return None;
        };
        if !seconds.is_finite() || seconds <= 0.0 {
            return None;
        }
        Some(SessionWatch {
            changes,
            organization,
            hash: self.token_hash.clone(),
            // Count SQL latency conservatively: never extend a session past its DB expiry.
            deadline: checked_at
                + Duration::from_secs_f64(seconds.min(f64::from(super::SESSION_SECONDS))),
        })
    }
}

impl SessionWatch {
    pub(crate) async fn ended(&mut self) {
        loop {
            tokio::select! {
                biased;
                _ = tokio::time::sleep_until(self.deadline) => return,
                result = self.changes.recv() => match result {
                    Ok((organization, hash)) if organization == self.organization && hash == self.hash => return,
                    Ok(_) => {},
                    // If revocations outrun the receiver, close conservatively rather than miss one.
                    Err(_) => return,
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn session_watch_expires_and_only_matching_sign_out_ends_it() {
        let changes = SessionChanges::default();
        let organization = Uuid::new_v4();
        let mut watch = SessionWatch {
            changes: changes.0.subscribe(),
            organization,
            hash: vec![1],
            deadline: Instant::now() + Duration::from_secs(3),
        };
        changes.revoked(Uuid::new_v4(), vec![1]);
        changes.revoked(organization, vec![2]);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), watch.ended())
                .await
                .is_err()
        );
        changes.revoked(organization, vec![1]);
        watch.ended().await;
        let mut expiry = SessionWatch {
            changes: changes.0.subscribe(),
            organization,
            hash: vec![1],
            deadline: Instant::now() + Duration::from_secs(3),
        };
        let started = Instant::now();
        expiry.ended().await;
        assert_eq!(Instant::now() - started, Duration::from_secs(3));
    }
    #[tokio::test]
    async fn missed_session_revocations_fail_closed() {
        let changes = SessionChanges::default();
        let mut watch = SessionWatch {
            changes: changes.0.subscribe(),
            organization: Uuid::new_v4(),
            hash: vec![1],
            deadline: Instant::now() + Duration::from_secs(60),
        };
        for _ in 0..2048 {
            changes.revoked(Uuid::new_v4(), vec![2]);
        }
        tokio::time::timeout(Duration::from_secs(1), watch.ended())
            .await
            .unwrap();
    }
}
