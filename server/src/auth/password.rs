use super::{ApiError, fill_random, throttle};
use argon2::{Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version};
use axum::http::StatusCode;
use std::time::Duration;
use tokio::sync::{Semaphore, SemaphorePermit};

const PASSWORD_CONCURRENCY: usize = 4;
const PASSWORD_QUEUE_CAP: usize = 32;
const PASSWORD_WAIT: Duration = Duration::from_secs(1);

pub(super) struct PasswordWorkers {
    pub(super) running: Semaphore,
    pub(super) waiting: Semaphore,
    #[cfg(test)]
    pub(super) on_start: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

pub(super) struct PasswordPermit {
    _running: SemaphorePermit<'static>,
    #[cfg(test)]
    workers: &'static PasswordWorkers,
}

#[cfg(test)]
impl std::fmt::Debug for PasswordPermit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PasswordPermit").finish_non_exhaustive()
    }
}

impl PasswordWorkers {
    pub(super) const fn new() -> Self {
        Self {
            running: Semaphore::const_new(PASSWORD_CONCURRENCY),
            waiting: Semaphore::const_new(PASSWORD_QUEUE_CAP),
            #[cfg(test)]
            on_start: std::sync::Mutex::new(None),
        }
    }

    pub(super) async fn acquire(&'static self) -> Result<PasswordPermit, ApiError> {
        let permit = self.acquire_running().await?;
        Ok(PasswordPermit {
            _running: permit,
            #[cfg(test)]
            workers: self,
        })
    }

    async fn acquire_running(&self) -> Result<SemaphorePermit<'_>, ApiError> {
        if let Ok(permit) = self.running.try_acquire() {
            return Ok(permit);
        }
        // Reserve synchronously: a timeout by itself would allow unbounded waiters.
        let _waiting = self.waiting.try_acquire().map_err(|_| unavailable())?;
        tokio::time::timeout(PASSWORD_WAIT, self.running.acquire())
            .await
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())
    }
}

fn unavailable() -> ApiError {
    ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "password admission unavailable",
        Some(Duration::from_secs(rand::random_range(1..=5))),
    )
}

pub(super) async fn hash_password(
    password: String,
    workers: &'static PasswordWorkers,
) -> Result<String, ApiError> {
    hash_password_with_entropy(password, workers, fill_random).await
}

pub(super) async fn hash_password_with_entropy(
    password: String,
    workers: &'static PasswordWorkers,
    entropy: impl FnOnce(&mut [u8]) -> Result<(), ApiError> + Send + 'static,
) -> Result<String, ApiError> {
    let permit = workers.acquire().await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        hash_password_sync_with_entropy(password.as_bytes(), entropy)
    })
    .await
    .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error", None))?
    .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error", None))
}

pub(super) async fn check_password(
    password: String,
    stored: Option<String>,
    attempt: throttle::Attempt,
    permit: PasswordPermit,
) -> Result<bool, ApiError> {
    check_password_with_hash(password, stored, attempt, permit, hash_password_sync).await
}

async fn check_password_with_hash(
    password: String,
    stored: Option<String>,
    attempt: throttle::Attempt,
    permit: PasswordPermit,
    dummy_hash: impl FnOnce(&[u8]) -> Result<String, ApiError> + Send + 'static,
) -> Result<bool, ApiError> {
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        #[cfg(test)]
        if let Some(on_start) = _permit.workers.on_start.lock().unwrap().take() {
            on_start();
        }
        let valid = match stored {
            Some(stored) => {
                let argon2 = password_hasher();
                PasswordHash::new(&stored)
                    .is_ok_and(|hash| argon2.verify_password(password.as_bytes(), &hash).is_ok())
            }
            None => {
                // Unknown organization/email spends the same password work.
                dummy_hash(password.as_bytes())?;
                false
            }
        };
        // Keep the reservation and record failures even if the HTTP task was cancelled.
        if !valid {
            attempt.failed();
        } else {
            drop(attempt);
        }
        Ok(valid)
    })
    .await
    .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error", None))?
}

fn hash_password_sync(password: &[u8]) -> Result<String, ApiError> {
    #[cfg(test)]
    tests::record_hash(password);
    hash_password_sync_with_entropy(password, fill_random)
}

fn hash_password_sync_with_entropy(
    password: &[u8],
    entropy: impl FnOnce(&mut [u8]) -> Result<(), ApiError>,
) -> Result<String, ApiError> {
    let mut salt = [0u8; 16];
    entropy(&mut salt)?;
    password_hasher()
        .hash_password_with_salt(password, &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error", None))
}

// Preserve the pre-migration algorithm and costs independently of crate defaults.
// Invalid edits fail constant evaluation instead of bypassing failure accounting.
const PASSWORD_PARAMS: Params = match Params::new(19_456, 2, 1, Some(32)) {
    Ok(params) => params,
    Err(_) => unreachable!(),
};

fn password_hasher() -> Argon2<'static> {
    Argon2::new(Algorithm::Argon2id, Version::V0x13, PASSWORD_PARAMS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, http::header, response::IntoResponse};
    use serde_json::{Value, json};
    use std::{
        collections::BTreeMap,
        sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

    // Observe only registered passwords, so parallel password tests cannot interfere.
    static HASH_CALLS: Mutex<BTreeMap<Vec<u8>, usize>> = Mutex::new(BTreeMap::new());

    #[tokio::test(start_paused = true)]
    async fn queue_is_bounded_and_cancellation_releases_waiters() {
        let workers: &'static PasswordWorkers = Box::leak(Box::new(PasswordWorkers::new()));
        let held = workers
            .running
            .acquire_many(PASSWORD_CONCURRENCY as u32)
            .await
            .unwrap();
        let mut tasks = Vec::new();
        for _ in 0..PASSWORD_QUEUE_CAP {
            let workers: &'static PasswordWorkers = workers;
            tasks.push(tokio::spawn(async move { workers.acquire().await }));
        }
        let watchdog = std::time::Instant::now();
        while workers.waiting.available_permits() != 0 {
            assert!(watchdog.elapsed() < Duration::from_secs(30), "test stalled");
            tokio::task::yield_now().await;
        }
        let rejected = tokio::time::timeout(Duration::ZERO, workers.acquire())
            .await
            .expect("a full queue must reject immediately");
        assert_eq!(rejected.unwrap_err().0, StatusCode::SERVICE_UNAVAILABLE);
        for task in tasks {
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        }
        assert_eq!(workers.waiting.available_permits(), PASSWORD_QUEUE_CAP);
        // Admitted work also releases the queue reservation immediately.
        let waiting = tokio::spawn(async move { workers.acquire().await });
        tokio::task::yield_now().await;
        drop(held);
        let admitted = waiting.await.unwrap().unwrap();
        assert_eq!(workers.waiting.available_permits(), PASSWORD_QUEUE_CAP);
        assert_eq!(
            workers.running.available_permits(),
            PASSWORD_CONCURRENCY - 1
        );
        drop(admitted);
        assert_eq!(workers.running.available_permits(), PASSWORD_CONCURRENCY);
    }

    pub(super) fn record_hash(password: &[u8]) {
        if let Some(calls) = HASH_CALLS.lock().unwrap().get_mut(password) {
            *calls += 1;
        }
    }

    #[tokio::test]
    async fn unknown_account_runs_dummy_argon2() {
        let password = format!("dummy hash wiring {}", uuid::Uuid::new_v4());
        HASH_CALLS
            .lock()
            .unwrap()
            .insert(password.as_bytes().to_vec(), 0);
        let attempt = super::super::SignInThrottle::default()
            .begin("192.0.2.1".parse().unwrap())
            .unwrap();
        assert!(
            !check_password(
                password.clone(),
                None,
                attempt,
                super::super::PASSWORD_WORKERS.acquire().await.unwrap(),
            )
            .await
            .unwrap()
        );
        assert_eq!(
            HASH_CALLS.lock().unwrap().remove(password.as_bytes()),
            Some(1)
        );
    }

    #[tokio::test]
    async fn production_password_hash_salts_vary_per_call() {
        let password = "correct horse battery staple";
        let first = hash_password(password.into(), &super::super::PASSWORD_WORKERS)
            .await
            .unwrap();
        let second = hash_password(password.into(), &super::super::PASSWORD_WORKERS)
            .await
            .unwrap();
        let first = PasswordHash::new(&first).unwrap();
        let second = PasswordHash::new(&second).unwrap();
        assert_ne!(first.salt.unwrap(), second.salt.unwrap());
    }

    #[tokio::test(start_paused = true)]
    async fn unknown_account_salt_entropy_failure_returns_500_without_spending_failure_budgets() {
        for partial in [false, true] {
            let calls = Arc::new(AtomicUsize::new(0));
            let observed = calls.clone();
            let throttle = super::super::SignInThrottle::default();
            let ip = "192.0.2.1".parse().unwrap();
            let mut attempt = throttle.begin(ip).unwrap();
            attempt.account("unknown@example.com".into()).unwrap();
            let error = check_password_with_hash(
                "correct horse battery staple".into(),
                None,
                attempt,
                super::super::PASSWORD_WORKERS.acquire().await.unwrap(),
                move |password| {
                    hash_password_sync_with_entropy(password, |bytes| {
                        observed.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(bytes.len(), 16);
                        if partial {
                            bytes[..8].fill(0xab);
                        }
                        Err(ApiError(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "internal error",
                            None,
                        ))
                    })
                },
            )
            .await
            .unwrap_err();
            let response = error.into_response();
            assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert!(!response.headers().contains_key(header::SET_COOKIE));
            let body = to_bytes(response.into_body(), 1024).await.unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap(),
                json!({"error": "internal error"})
            );
            assert_eq!(calls.load(Ordering::SeqCst), 1);

            // All five ordinary failures must remain available for this account.
            // Reaching both full limits also proves both reservations were released.
            for _ in 0..5 {
                let mut attempt = throttle.begin(ip).unwrap();
                attempt.account("unknown@example.com".into()).unwrap();
                assert!(
                    !check_password(
                        "incorrect password".into(),
                        None,
                        attempt,
                        super::super::PASSWORD_WORKERS.acquire().await.unwrap(),
                    )
                    .await
                    .unwrap()
                );
            }
            let mut rejected = throttle.begin("192.0.2.2".parse().unwrap()).unwrap();
            assert!(rejected.account("unknown@example.com".into()).is_err());
            drop(rejected);

            // Other accounts isolate the remaining IP budget from the account limit.
            for n in 5..20 {
                let mut attempt = throttle.begin(ip).unwrap();
                attempt.account(format!("unknown-{n}@example.com")).unwrap();
                assert!(
                    !check_password(
                        "incorrect password".into(),
                        None,
                        attempt,
                        super::super::PASSWORD_WORKERS.acquire().await.unwrap(),
                    )
                    .await
                    .unwrap()
                );
            }
            assert!(throttle.begin(ip).is_err());
            assert!(throttle.begin("192.0.2.2".parse().unwrap()).is_ok());
        }
    }

    #[test]
    fn password_salt_entropy_success_encodes_every_byte_once() {
        let mut calls = 0;
        let password = b"correct horse battery staple";
        let hash = hash_password_sync_with_entropy(password, |bytes| {
            calls += 1;
            assert_eq!(bytes.len(), 16);
            bytes.copy_from_slice(b"0123456789abcdef");
            Ok(())
        })
        .unwrap();
        assert_eq!(calls, 1);
        // Independent pre-migration argon2 0.5.3 fixture, also used by the HTTP test.
        assert_eq!(
            hash,
            "$argon2id$v=19$m=19456,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$gy5SuVm5Z7Vw7keB9se9p87QGcomaseB/S2U1OhTsM0"
        );
    }
}
