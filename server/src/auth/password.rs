use super::{ApiError, fill_random, throttle};
use argon2::{Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version};
use axum::http::StatusCode;

pub(super) async fn hash_password(
    password: String,
    workers: &'static tokio::sync::Semaphore,
) -> Result<String, ApiError> {
    hash_password_with_entropy(password, workers, fill_random).await
}

pub(super) async fn hash_password_with_entropy(
    password: String,
    workers: &'static tokio::sync::Semaphore,
    entropy: impl FnOnce(&mut [u8]) -> Result<(), ApiError> + Send + 'static,
) -> Result<String, ApiError> {
    let permit = workers
        .acquire()
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error", None))?;
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
    workers: &'static tokio::sync::Semaphore,
) -> Result<bool, ApiError> {
    check_password_with_hash(password, stored, attempt, workers, hash_password_sync).await
}

async fn check_password_with_hash(
    password: String,
    stored: Option<String>,
    attempt: throttle::Attempt,
    workers: &'static tokio::sync::Semaphore,
    dummy_hash: impl FnOnce(&[u8]) -> Result<String, ApiError> + Send + 'static,
) -> Result<bool, ApiError> {
    let permit = workers
        .acquire()
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error", None))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
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
                &super::super::PASSWORD_WORKERS,
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
    async fn unknown_account_salt_entropy_failure_returns_500_without_fallback() {
        for partial in [false, true] {
            let calls = Arc::new(AtomicUsize::new(0));
            let observed = calls.clone();
            let throttle = super::super::SignInThrottle::default();
            let ip = "192.0.2.1".parse().unwrap();
            let attempt = throttle.begin(ip).unwrap();
            let error = check_password_with_hash(
                "correct horse battery staple".into(),
                None,
                attempt,
                &super::super::PASSWORD_WORKERS,
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
