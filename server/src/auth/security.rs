use super::{
    AccountAuth, ApiError, ApiJson, ErrorBody, PASSWORD_WORKERS, PasswordWorkers,
    RetryAfterSeconds,
    password::{PasswordPermit, check_and_hash_password},
    throttle::Attempt,
};
use crate::AppState;
use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use utoipa::ToSchema;

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ChangePasswordRequest {
    #[schema(max_length = 1024, format = Password)]
    pub current_password: String,
    /// At least 12 characters, at most 1024 UTF-8 bytes.
    #[schema(min_length = 12, max_length = 1024, format = Password)]
    pub new_password: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RevokeOtherSessionsRequest {
    #[schema(max_length = 1024, format = Password)]
    pub current_password: String,
}

#[utoipa::path(put, path = "/api/v1/me/password", request_body = ChangePasswordRequest,
    description = "Lock Account FOR UPDATE, then recheck current Session, verify password and update/delete Sessions through COMMIT; shared with web/native sign-in. Signal revoked tokens after COMMIT.",
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 204, description = "Password changed with Argon2; every other cookie/bearer Account Session revoked across Organizations; current Session preserved"),
    (status = 400, description = "invalid_new_password: fewer than 12 characters or more than 1024 UTF-8 bytes; otherwise invalid input", body = ErrorBody),
    (status = 401, description = "Only missing, invalid, expired or revoked Account Session", body = ErrorBody),
    (status = 403, description = "current_password_incorrect; no password or Session changes; current Session remains valid", body = ErrorBody),
    (status = 413, description = "Request body too large", body = ErrorBody),
    (status = 415, description = "Expected application/json", body = ErrorBody),
    (status = 429, description = "too many sign-in attempts; shared IP/email failure and reservation budgets with web/native sign-in and revoke-others", body = ErrorBody,
        headers(("Retry-After" = inline(RetryAfterSeconds), description = "Seconds until retry; at least 1"))),
    (status = 500, description = "Database or password worker failure; transaction rolled back", body = ErrorBody),
    (status = 503, description = "password admission unavailable; no mutation", body = ErrorBody)))]
pub async fn change_password(
    State(state): State<AppState>,
    auth: AccountAuth,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<ChangePasswordRequest>,
) -> Result<Response, ApiError> {
    change_password_with_workers(state, auth, peer, headers, input, &PASSWORD_WORKERS).await
}

async fn change_password_with_workers(
    state: AppState,
    auth: AccountAuth,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    input: ChangePasswordRequest,
    workers: &'static PasswordWorkers,
) -> Result<Response, ApiError> {
    if input.new_password.chars().count() < 12 || input.new_password.len() > 1024 {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid_new_password",
            None,
        ));
    }
    secure_account(
        state,
        auth,
        peer,
        headers,
        input.current_password,
        Some(input.new_password),
        workers,
    )
    .await
}

#[utoipa::path(post, path = "/api/v1/me/sessions/revoke-others", request_body = RevokeOtherSessionsRequest,
    description = "Lock Account FOR UPDATE, then recheck current Session, verify password and delete other Sessions through COMMIT; shared with web/native sign-in. Signal each revoked token after COMMIT, including on HTTP cancellation.",
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 204, description = "Every other cookie/bearer Account Session revoked across Organizations; current Session preserved"),
    (status = 400, description = "Invalid JSON, fields or current password length", body = ErrorBody),
    (status = 401, description = "Only missing, invalid, expired or revoked Account Session", body = ErrorBody),
    (status = 403, description = "current_password_incorrect; no password or Session changes; current Session remains valid", body = ErrorBody),
    (status = 413, description = "Request body too large", body = ErrorBody),
    (status = 415, description = "Expected application/json", body = ErrorBody),
    (status = 429, description = "too many sign-in attempts; shared IP/email failure and reservation budgets with web/native sign-in and password change", body = ErrorBody,
        headers(("Retry-After" = inline(RetryAfterSeconds), description = "Seconds until retry; at least 1"))),
    (status = 500, description = "Database or password worker failure; transaction rolled back", body = ErrorBody),
    (status = 503, description = "password admission unavailable; no mutation", body = ErrorBody)))]
pub async fn revoke_others(
    State(state): State<AppState>,
    auth: AccountAuth,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<RevokeOtherSessionsRequest>,
) -> Result<Response, ApiError> {
    secure_account(
        state,
        auth,
        peer,
        headers,
        input.current_password,
        None,
        &PASSWORD_WORKERS,
    )
    .await
}

async fn secure_account(
    state: AppState,
    auth: AccountAuth,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    current_password: String,
    new_password: Option<String>,
    workers: &'static PasswordWorkers,
) -> Result<Response, ApiError> {
    super::authorization::require(
        super::Actor::Account,
        super::Action::Account,
        super::Resource::Global,
    )?;
    if current_password.is_empty() || current_password.len() > 1024 {
        return Err(ApiError::bad_request());
    }
    let ip = state.sign_in_throttle.client_ip(peer, &headers);
    let mut attempt = state
        .sign_in_throttle
        .begin(ip)
        .map_err(ApiError::throttled)?;
    let email = sqlx::query_scalar("SELECT email FROM accounts WHERE id = $1")
        .bind(auth.account_id)
        .fetch_one(&state.pool)
        .await?;
    attempt.account(email).map_err(ApiError::throttled)?;
    let permit = workers.acquire().await?;
    // Own COMMIT and every notification independently of the HTTP caller.
    tokio::spawn(async move {
        let hashes = update_and_revoke(
            &state.pool,
            auth,
            current_password,
            new_password,
            attempt,
            permit,
        )
        .await?;
        for hash in hashes {
            state.session_changes.revoked(hash);
        }
        Ok::<_, ApiError>(())
    })
    .await
    .map_err(|_| ApiError::from(sqlx::Error::WorkerCrashed))??;
    Ok((
        StatusCode::NO_CONTENT,
        [(header::CACHE_CONTROL, "no-store")],
    )
        .into_response())
}

async fn update_and_revoke(
    pool: &sqlx::PgPool,
    auth: AccountAuth,
    current_password: String,
    new_password: Option<String>,
    attempt: Attempt,
    permit: PasswordPermit,
) -> Result<Vec<Vec<u8>>, ApiError> {
    let mut tx = pool.begin().await?;
    let stored = sqlx::query_scalar("SELECT password_hash FROM accounts WHERE id = $1 FOR UPDATE")
        .bind(auth.account_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    let current = sqlx::query_scalar::<_, Vec<u8>>(
        "SELECT token_hash FROM account_sessions WHERE account_id = $1 AND token_hash = $2 AND expires_at > clock_timestamp() FOR UPDATE",
    ).bind(auth.account_id).bind(&auth.token_hash).fetch_optional(&mut *tx).await?;
    if current.is_none() {
        return Err(ApiError::unauthorized());
    }
    let (valid, hash) =
        check_and_hash_password(current_password, stored, attempt, permit, new_password).await?;
    if !valid {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "current_password_incorrect",
            None,
        ));
    }
    if let Some(hash) = hash {
        sqlx::query("UPDATE accounts SET password_hash = $2 WHERE id = $1")
            .bind(auth.account_id)
            .bind(hash)
            .execute(&mut *tx)
            .await?;
    }
    let hashes = sqlx::query_scalar(
        "DELETE FROM account_sessions WHERE account_id = $1 AND token_hash <> $2 RETURNING token_hash",
    ).bind(auth.account_id).bind(auth.token_hash).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(hashes)
}

#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) mod test_support;
