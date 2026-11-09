use super::{ApiError, fill_random, throttle};
use argon2::{Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version};
use axum::http::StatusCode;

pub(super) async fn hash_password(
    password: String,
    workers: &'static tokio::sync::Semaphore,
) -> Result<String, ApiError> {
    let permit = workers
        .acquire()
        .await
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error", None))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        hash_password_sync(password.as_bytes())
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
                let argon2 = password_hasher()?;
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
    let mut salt = [0u8; 16];
    fill_random(&mut salt)?;
    password_hasher()?
        .hash_password_with_salt(password, &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error", None))
}

// Preserve the pre-migration algorithm and costs independently of crate defaults.
fn password_hasher() -> Result<Argon2<'static>, ApiError> {
    let params = Params::new(19_456, 2, 1, Some(32))
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error", None))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unknown_account_runs_dummy_argon2() {
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed = calls.clone();
        let attempt = super::super::SignInThrottle::default()
            .begin("192.0.2.1".parse().unwrap())
            .unwrap();
        assert!(
            !check_password_with_hash(
                "correct horse battery staple".into(),
                None,
                attempt,
                &super::super::PASSWORD_WORKERS,
                move |password| {
                    observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let hash = hash_password_sync(password)?;
                    assert!(hash.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"));
                    Ok(hash)
                },
            )
            .await
            .unwrap()
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
