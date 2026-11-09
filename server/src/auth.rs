use axum::{
    Json,
    extract::{ConnectInfo, FromRequest, FromRequestParts, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts},
    response::{IntoResponse, Response},
};
use rand::{TryRngCore, rngs::OsRng};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use subtle::ConstantTimeEq;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::AppState;

mod cleanup;
#[cfg(test)]
mod credential_tests;
mod password;
use password::{check_password, hash_password};
mod session;
mod throttle;
pub use cleanup::SessionCleanup;
pub use session::SessionChanges;
pub use throttle::SignInThrottle;

// Bound Argon2 memory/CPU work independently from Tokio blocking-thread capacity.
static PASSWORD_WORKERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

const COOKIE: &str = "fukulow_session";
const SESSION_SECONDS: u32 = 30 * 24 * 60 * 60;

#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorBody {
    pub error: String,
}

#[derive(Debug)]
pub struct ApiError(StatusCode, &'static str, Option<std::time::Duration>);
impl ApiError {
    fn unauthorized() -> Self {
        Self(StatusCode::UNAUTHORIZED, "invalid credentials", None)
    }
    fn bad_request() -> Self {
        Self(StatusCode::BAD_REQUEST, "invalid input", None)
    }
    fn throttled(retry: std::time::Duration) -> Self {
        Self(
            StatusCode::TOO_MANY_REQUESTS,
            "too many sign-in attempts",
            Some(retry),
        )
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (
            self.0,
            Json(ErrorBody {
                error: self.1.into(),
            }),
        )
            .into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        if let Some(retry) = self.2 {
            let seconds = retry.as_secs() + u64::from(retry.subsec_nanos() > 0);
            if let Ok(value) = HeaderValue::from_str(&seconds.max(1).to_string()) {
                response.headers_mut().insert(header::RETRY_AFTER, value);
            }
        }
        response
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        eprintln!("database operation failed: {error}");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "internal error", None)
    }
}

// Keep extractor failures in the same JSON contract as handler errors.
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|rejection| match rejection.status() {
                StatusCode::PAYLOAD_TOO_LARGE => ApiError(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "request body too large",
                    None,
                ),
                StatusCode::UNSUPPORTED_MEDIA_TYPE => ApiError(
                    StatusCode::UNSUPPORTED_MEDIA_TYPE,
                    "expected application/json",
                    None,
                ),
                _ => ApiError::bad_request(),
            })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "text", rename_all = "lowercase")]
pub enum Role {
    Owner,
    Admin,
    Member,
    Guest,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct Organization {
    pub organization_id: Uuid,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct Member {
    pub id: Uuid,
    pub email: String,
    pub name: String,
    pub role: Role,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct Identity {
    pub organization: Organization,
    pub member: Member,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SetupRequest {
    /// Required when FUKULOW_SETUP_TOKEN is configured on the server.
    #[schema(format = Password)]
    pub setup_token: Option<String>,
    #[schema(min_length = 1, max_length = 200)]
    pub organization_name: String,
    #[schema(min_length = 1, max_length = 200)]
    pub name: String,
    #[schema(max_length = 254)]
    pub email: String,
    /// At least 12 characters, at most 1024 UTF-8 bytes.
    #[schema(min_length = 12, max_length = 1024, format = Password)]
    pub password: String,
}

#[derive(Serialize, ToSchema)]
pub struct SetupStatus {
    pub setup_required: bool,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SignInRequest {
    /// Returned by setup; may be omitted only when exactly one organization exists.
    pub organization_id: Option<Uuid>,
    pub email: String,
    #[schema(max_length = 1024, format = Password)]
    pub password: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct SessionResponse {
    pub identity: Identity,
    /// Opaque bearer credential. Store securely; returned only on sign-in.
    pub token: String,
    pub expires_in: u32,
}

fn email(value: &str) -> Result<String, ApiError> {
    let value = value.trim().to_lowercase();
    let Some((local, domain)) = value.split_once('@') else {
        return Err(ApiError::bad_request());
    };
    if value.len() > 254
        || local.is_empty()
        || domain.is_empty()
        || domain.contains('@')
        || value.chars().any(char::is_whitespace)
    {
        return Err(ApiError::bad_request());
    }
    Ok(value)
}

// Global bootstrap is a tenant-scope exception: only existence is exposed.
async fn organization_exists<'e>(executor: impl sqlx::PgExecutor<'e>) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM organizations)")
        .fetch_one(executor)
        .await
}

/// Report whether the first organization still needs to be created.
/// Accessible without authentication or a setup token; reveals only setup_required.
#[utoipa::path(get, path = "/api/v1/setup", security(),
    responses((status = 200, description = "Whether the first Organization still needs to be created", body = SetupStatus,
        headers(("Cache-Control" = String, description = "no-store"))),
    (status = 500, description = "Database failure while checking whether an Organization exists", body = ErrorBody)))]
pub async fn setup_status(State(state): State<AppState>) -> Result<Response, ApiError> {
    let setup_required = !organization_exists(&state.pool).await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(SetupStatus { setup_required }),
    )
        .into_response())
}

/// Create the first organization and Owner.
///
/// Body extraction precedes setup-token verification: malformed JSON or invalid field
/// types return 400, oversized bodies return 413, and unsupported content types return
/// 415 even when the setup token is missing or invalid. After extraction, the token is
/// checked before semantic input validation, password hashing, or database access.
#[utoipa::path(post, path = "/api/v1/setup", request_body = SetupRequest,
    responses((status = 201, description = "Created the first Organization and Owner; returns their identity", body = Identity),
    (status = 400, description = "Invalid JSON, fields, or input; body extraction precedes setup-token verification", body = ErrorBody),
    (status = 401, description = "Missing or invalid setup token after successful body extraction", body = ErrorBody),
    (status = 409, description = "Setup already completed", body = ErrorBody),
    (status = 413, description = "Request body too large", body = ErrorBody),
    (status = 415, description = "Expected application/json", body = ErrorBody)))]
pub async fn setup(
    State(state): State<AppState>,
    ApiJson(input): ApiJson<SetupRequest>,
) -> Result<Response, ApiError> {
    setup_with_workers(state, input, &PASSWORD_WORKERS).await
}

async fn setup_with_workers(
    state: AppState,
    input: SetupRequest,
    workers: &'static tokio::sync::Semaphore,
) -> Result<Response, ApiError> {
    if let Some(expected) = &state.setup_token {
        let supplied = input
            .setup_token
            .as_deref()
            .ok_or_else(ApiError::unauthorized)?;
        // Compare fixed-size digests so equality never exits on token length or prefix.
        if !bool::from(
            Sha256::digest(expected.as_bytes()).ct_eq(&Sha256::digest(supplied.as_bytes())),
        ) {
            return Err(ApiError::unauthorized());
        }
    }
    let email = email(&input.email)?;
    let organization_name = input.organization_name.trim();
    let name = input.name.trim();
    if organization_name.is_empty()
        || organization_name.chars().count() > 200
        || name.is_empty()
        || name.chars().count() > 200
        || input.password.chars().count() < 12
        || input.password.len() > 1024
    {
        return Err(ApiError::bad_request());
    }
    // Global bootstrap fast path: completed setup never consumes password workers
    // or takes the setup lock. The transactional check below still closes the race.
    if organization_exists(&state.pool).await? {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "setup already completed",
            None,
        ));
    }
    let password_hash = hash_password(input.password, workers).await?;
    let mut tx = state.pool.begin().await?;
    // Global bootstrap is a tenant-scope exception. The table lock also
    // serializes setup across processes and concurrent first requests.
    sqlx::query("LOCK TABLE organizations IN EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await?;
    if organization_exists(&mut *tx).await? {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "setup already completed",
            None,
        ));
    }
    let organization_id = Uuid::new_v4();
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (organization_id, name) VALUES ($1, $2)")
        .bind(organization_id)
        .bind(organization_name)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO users (organization_id, id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5, 'owner')")
        .bind(organization_id).bind(id).bind(&email).bind(name).bind(password_hash).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(Identity {
            organization: Organization {
                organization_id,
                name: organization_name.into(),
            },
            member: Member {
                id,
                email,
                name: name.into(),
                role: Role::Owner,
            },
        }),
    )
        .into_response())
}

#[derive(FromRow)]
struct IdentityRow {
    organization_id: Uuid,
    organization_name: String,
    id: Uuid,
    email: String,
    name: String,
    role: Role,
}
impl From<IdentityRow> for Identity {
    fn from(row: IdentityRow) -> Self {
        Self {
            organization: Organization {
                organization_id: row.organization_id,
                name: row.organization_name,
            },
            member: Member {
                id: row.id,
                email: row.email,
                name: row.name,
                role: row.role,
            },
        }
    }
}

struct RetryAfterSeconds;

impl utoipa::PartialSchema for RetryAfterSeconds {
    fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
        use utoipa::openapi::schema::{KnownFormat, Object, SchemaFormat, Type};

        Object::builder()
            .schema_type(Type::Integer)
            .format(Some(SchemaFormat::KnownFormat(KnownFormat::Int64)))
            .minimum(Some(1.0))
            .build()
            .into()
    }
}

impl ToSchema for RetryAfterSeconds {}

#[utoipa::path(post, path = "/api/v1/session", request_body = SignInRequest,
    responses((status = 200, description = "Signed in; returns identity, session token and expiry, and sets the session cookie", body = SessionResponse, headers(("Set-Cookie" = String, description = "HttpOnly; SameSite=Strict; Path=/; Secure by default"))),
    (status = 400, description = "Invalid sign-in JSON, fields, email or password length, or omitted Organization when no sole Organization exists", body = ErrorBody),
    (status = 401, description = "Email or password does not match an account in the selected Organization", body = ErrorBody),
    (status = 413, description = "Request body too large", body = ErrorBody),
    (status = 415, description = "Expected application/json", body = ErrorBody),
    (status = 429, description = "Too many failed or in-flight sign-in attempts", body = ErrorBody,
        headers(("Retry-After" = inline(RetryAfterSeconds), description = "Seconds until retry; at least 1")))))]
pub async fn sign_in(
    State(state): State<AppState>,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    ApiJson(input): ApiJson<SignInRequest>,
) -> Result<Response, ApiError> {
    sign_in_with_workers(state, peer, headers, input, &PASSWORD_WORKERS).await
}

async fn sign_in_with_workers(
    state: AppState,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    input: SignInRequest,
    workers: &'static tokio::sync::Semaphore,
) -> Result<Response, ApiError> {
    sign_in_with_entropy(state, peer, headers, input, workers, fill_random).await
}

async fn sign_in_with_entropy(
    state: AppState,
    peer: ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    input: SignInRequest,
    workers: &'static tokio::sync::Semaphore,
    entropy: impl FnOnce(&mut [u8]) -> Result<(), ApiError>,
) -> Result<Response, ApiError> {
    let email = email(&input.email)?;
    if input.password.is_empty() || input.password.len() > 1024 {
        return Err(ApiError::bad_request());
    }
    let ip = state.sign_in_throttle.client_ip(peer, &headers);
    let mut attempt = state
        .sign_in_throttle
        .begin(ip)
        .map_err(ApiError::throttled)?;
    let organization_id = match input.organization_id {
        Some(id) => id,
        None => {
            // Discover only whether there is a sole tenant; member lookup stays scoped.
            let organizations =
                sqlx::query_scalar::<_, Uuid>("SELECT organization_id FROM organizations LIMIT 2")
                    .fetch_all(&state.pool)
                    .await?;
            let [id] = organizations.as_slice() else {
                attempt.failed();
                return Err(ApiError::bad_request());
            };
            *id
        }
    };
    attempt
        .account(organization_id, email.clone())
        .map_err(ApiError::throttled)?;
    let stored = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id, password_hash FROM users WHERE organization_id = $1 AND email = $2",
    )
    .bind(organization_id)
    .bind(email)
    .fetch_optional(&state.pool)
    .await?;
    let (user_id, password_hash) = stored.unzip();
    if !check_password(input.password, password_hash, attempt, workers).await? {
        return Err(ApiError::unauthorized());
    }
    let user_id = user_id.ok_or_else(ApiError::unauthorized)?;
    let mut random = [0u8; 32];
    entropy(&mut random)?;
    let secret: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let token = format!("{organization_id}.{secret}");
    let token_hash = Sha256::digest(token.as_bytes()).to_vec();
    sqlx::query("INSERT INTO sessions (organization_id, token_hash, user_id) VALUES ($1, $2, $3)")
        .bind(organization_id)
        .bind(&token_hash)
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    let identity = identity(&state, organization_id, &token_hash).await?;
    state.session_cleanup.trigger(&state.pool);
    Ok((
        [
            (header::SET_COOKIE, cookie(&state, &token, SESSION_SECONDS)),
            (header::CACHE_CONTROL, "no-store".into()),
        ],
        Json(SessionResponse {
            identity,
            token,
            expires_in: SESSION_SECONDS,
        }),
    )
        .into_response())
}

fn fill_random(bytes: &mut [u8]) -> Result<(), ApiError> {
    OsRng
        .try_fill_bytes(bytes)
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error", None))
}

fn cookie(state: &AppState, token: &str, seconds: u32) -> String {
    format!(
        "{COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={seconds}{}",
        if state.cookie_secure { "; Secure" } else { "" }
    )
}

async fn identity(
    state: &AppState,
    organization_id: Uuid,
    token_hash: &[u8],
) -> Result<Identity, ApiError> {
    let row = sqlx::query_as::<_, IdentityRow>(
        "SELECT u.organization_id, o.name AS organization_name, u.id, u.email, u.name, u.role \
         FROM sessions s \
         JOIN users u ON u.organization_id = s.organization_id AND u.id = s.user_id \
         JOIN organizations o ON o.organization_id = s.organization_id \
         WHERE s.organization_id = $1 AND s.token_hash = $2 AND s.expires_at > now()",
    )
    .bind(organization_id)
    .bind(token_hash)
    .fetch_optional(&state.pool)
    .await?;
    row.map(Into::into).ok_or_else(ApiError::unauthorized)
}

/// Trusted tenant and member for every authenticated endpoint. Never take tenant
/// scope from a query/header supplied separately from the session credential.
pub struct Auth {
    pub identity: Identity,
    token_hash: Vec<u8>,
}
impl FromRequestParts<AppState> for Auth {
    type Rejection = ApiError;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = credential(&parts.headers)?;
        let (organization, secret) = token.split_once('.').ok_or_else(ApiError::unauthorized)?;
        let organization_id =
            Uuid::parse_str(organization).map_err(|_| ApiError::unauthorized())?;
        if secret.len() != 64 || !secret.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(ApiError::unauthorized());
        }
        let token_hash = Sha256::digest(token.as_bytes()).to_vec();
        let identity = identity(state, organization_id, &token_hash).await?;
        Ok(Self {
            identity,
            token_hash,
        })
    }
}

fn credential(headers: &HeaderMap) -> Result<&str, ApiError> {
    // An explicit Authorization header always wins; never silently fall back to a cookie.
    if headers.contains_key(header::AUTHORIZATION) {
        let mut values = headers.get_all(header::AUTHORIZATION).iter();
        let value = values
            .next()
            .ok_or_else(ApiError::unauthorized)?
            .to_str()
            .map_err(|_| ApiError::unauthorized())?;
        if values.next().is_some() {
            return Err(ApiError::unauthorized());
        }
        let (scheme, token) = value.split_once(' ').ok_or_else(ApiError::unauthorized)?;
        if !scheme.eq_ignore_ascii_case("bearer") {
            return Err(ApiError::unauthorized());
        }
        return Ok(token);
    }
    let mut token = None;
    for value in headers.get_all(header::COOKIE) {
        for cookie in value
            .to_str()
            .map_err(|_| ApiError::unauthorized())?
            .split(';')
        {
            if let Some((name, value)) = cookie.trim().split_once('=')
                && name == COOKIE
            {
                if token.is_some() {
                    return Err(ApiError::unauthorized());
                }
                token = Some(value);
            }
        }
    }
    token.ok_or_else(ApiError::unauthorized)
}

#[utoipa::path(get, path = "/api/v1/me", security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Current session's Member and Organization identity", body = Identity),
    (status = 401, description = "Missing, invalid, ambiguous, expired, or revoked session credential", body = ErrorBody)))]
pub async fn me(auth: Auth) -> impl IntoResponse {
    ([(header::CACHE_CONTROL, "no-store")], Json(auth.identity))
}

#[utoipa::path(delete, path = "/api/v1/session", security(("cookie" = []), ("bearer" = [])),
    responses((status = 204, description = "Session revoked and cookie cleared", headers(("Set-Cookie" = String))),
    (status = 401, description = "Missing, invalid, ambiguous, expired, or revoked session credential", body = ErrorBody)))]
pub async fn sign_out(State(state): State<AppState>, auth: Auth) -> Result<Response, ApiError> {
    let pool = state.pool.clone();
    let changes = state.session_changes.clone();
    // Finish revocation + notification even if the HTTP caller disconnects.
    tokio::spawn(async move {
        let organization = auth.identity.organization.organization_id;
        sqlx::query("DELETE FROM sessions WHERE organization_id = $1 AND token_hash = $2")
            .bind(organization)
            .bind(&auth.token_hash)
            .execute(&pool)
            .await?;
        changes.revoked(organization, auth.token_hash);
        Ok::<_, sqlx::Error>(())
    })
    .await
    .map_err(|_| ApiError::from(sqlx::Error::WorkerCrashed))??;
    Ok((
        StatusCode::NO_CONTENT,
        [
            (header::SET_COOKIE, cookie(&state, "", 0)),
            (header::CACHE_CONTROL, "no-store".into()),
        ],
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use serde_json::json;
    use tower::ServiceExt;

    // The real app uses the process-global PASSWORD_WORKERS. These saturation tests
    // need an isolated semaphore so holding every permit cannot stall parallel tests.
    // This router uses the same handlers and extractors as crate::app, passing only
    // that semaphore explicitly, and matches its JSON body limit. Other routes and
    // the static fallback do not participate in setup or sign-in requests.
    fn app_with_workers(state: AppState, workers: &'static tokio::sync::Semaphore) -> axum::Router {
        axum::Router::new()
            .route(
                "/api/v1/setup",
                axum::routing::post(move |State(state), ApiJson(input)| {
                    setup_with_workers(state, input, workers)
                }),
            )
            .route(
                "/api/v1/session",
                axum::routing::post(move |State(state), peer, headers, ApiJson(input)| {
                    sign_in_with_workers(state, peer, headers, input, workers)
                }),
            )
            .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
            .with_state(state)
    }

    #[tokio::test]
    async fn password_verification_records_failures_for_known_and_unknown_accounts() {
        let password = "correct horse battery staple";
        let stored = hash_password(password.into(), &crate::auth::PASSWORD_WORKERS)
            .await
            .unwrap();
        for stored in [Some(stored), None] {
            let throttle = SignInThrottle::default();
            let organization = Uuid::new_v4();
            let ip = "192.0.2.1".parse().unwrap();
            if stored.is_some() {
                // Successful verification must release reservations without charging failures.
                for _ in 0..6 {
                    let mut attempt = throttle.begin(ip).unwrap();
                    attempt
                        .account(organization, "owner@example.com".into())
                        .unwrap();
                    assert!(
                        check_password(password.into(), stored.clone(), attempt, &PASSWORD_WORKERS)
                            .await
                            .unwrap()
                    );
                }
            }
            for _ in 0..5 {
                let mut attempt = throttle.begin(ip).unwrap();
                attempt
                    .account(organization, "owner@example.com".into())
                    .unwrap();
                assert!(
                    !check_password(
                        "incorrect password".into(),
                        stored.clone(),
                        attempt,
                        &PASSWORD_WORKERS
                    )
                    .await
                    .unwrap()
                );
            }
            let mut rejected = throttle.begin(ip).unwrap();
            assert!(
                rejected
                    .account(organization, "owner@example.com".into())
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn throttled_sign_in_skips_password_workers_and_database() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        let organization = Uuid::new_v4();
        let peer: std::net::SocketAddr = "192.0.2.1:1234".parse().unwrap();
        static WORKERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
        let _workers = WORKERS.acquire_many(4).await.unwrap();
        for by_ip in [false, true] {
            let throttle = SignInThrottle::default();
            for _ in 0..if by_ip { 20 } else { 5 } {
                let mut attempt = throttle.begin(peer.ip()).unwrap();
                if !by_ip {
                    attempt
                        .account(organization, "owner@example.com".into())
                        .unwrap();
                }
                attempt.failed();
            }
            let app = app_with_workers(
                AppState {
                    sign_in_throttle: throttle,
                    ..AppState::for_test(pool.clone())
                },
                &WORKERS,
            );
            for forwarded in ["198.51.100.1", "198.51.100.2"] {
                let request = Request::post("/api/v1/session")
                    .extension(ConnectInfo(peer))
                    .header(header::CONTENT_TYPE, "application/json")
                    .header("x-forwarded-for", forwarded)
                    .body(axum::body::Body::from(
                        json!({
                            "organization_id": if by_ip { None } else { Some(organization) },
                            "email": " Owner@Example.com ", "password": "incorrect password"
                        })
                        .to_string(),
                    ))
                    .unwrap();
                let response = tokio::time::timeout(
                    std::time::Duration::from_secs(1),
                    app.clone().oneshot(request),
                )
                .await
                .expect("throttled requests must not touch the database or wait for Argon2")
                .unwrap();
                assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
                assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
                assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
                assert!(!response.headers().contains_key(header::SET_COOKIE));
                let retry = response.headers()[header::RETRY_AFTER]
                    .to_str()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap();
                assert!((1..=60).contains(&retry));
                let body = to_bytes(response.into_body(), 1024).await.unwrap();
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                    json!({"error": "too many sign-in attempts"})
                );
            }
        }
    }

    #[tokio::test]
    async fn ipv6_prefix_failures_return_429_while_another_prefix_remains_usable() {
        let throttle = SignInThrottle::default();
        for n in 0..20 {
            throttle
                .begin(format!("2001:db8:abcd:1:{n}:1:2:{n}").parse().unwrap())
                .unwrap()
                .failed();
        }
        assert!(
            throttle
                .begin("2001:db8:abcd:2::1".parse().unwrap())
                .is_ok()
        );
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        let app = crate::app(AppState {
            sign_in_throttle: throttle,
            ..AppState::for_test(pool)
        });
        let request = Request::post("/api/v1/session")
            .extension(ConnectInfo(
                "[2001:db8:abcd:1:ffff:ffff:ffff:ffff]:1234"
                    .parse::<std::net::SocketAddr>()
                    .unwrap(),
            ))
            .header(header::CONTENT_TYPE, "application/json")
            .body(axum::body::Body::from(
                json!({"email": "owner@example.com", "password": "incorrect password"}).to_string(),
            ))
            .unwrap();
        let response =
            tokio::time::timeout(std::time::Duration::from_secs(1), app.oneshot(request))
                .await
                .expect("same-prefix requests must be throttled before database access")
                .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(response.headers().contains_key(header::RETRY_AFTER));
    }

    #[tokio::test]
    async fn retry_after_rounds_up_and_is_never_zero() {
        for (millis, seconds) in [(0, "1"), (1, "1"), (1000, "1"), (1001, "2"), (60_000, "60")] {
            let response =
                ApiError::throttled(std::time::Duration::from_millis(millis)).into_response();
            assert_eq!(response.headers()[header::RETRY_AFTER], seconds);
        }
    }

    #[sqlx::test]
    async fn completed_setup_skips_password_workers_and_setup_lock(pool: sqlx::PgPool) {
        sqlx::query("INSERT INTO organizations (organization_id, name) VALUES ($1, 'Existing')")
            .bind(Uuid::new_v4())
            .execute(&pool)
            .await
            .unwrap();
        static WORKERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
        let _workers = WORKERS.acquire_many(4).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("LOCK TABLE organizations IN EXCLUSIVE MODE")
            .execute(&mut *tx)
            .await
            .unwrap();

        for setup_token in [None, Some("test-only-token".to_owned())] {
            let app = app_with_workers(
                AppState {
                    setup_token: setup_token.clone(),
                    ..AppState::for_test(pool.clone())
                },
                &WORKERS,
            );
            let request = Request::post("/api/v1/setup")
                .header(header::CONTENT_TYPE, "application/json")
                .body(axum::body::Body::from(
                    json!({
                        "setup_token": setup_token,
                        "organization_name": "Another organization",
                        "name": "Owner",
                        "email": "owner@example.com",
                        "password": "correct horse battery staple"
                    })
                    .to_string(),
                ))
                .unwrap();
            // Neither an Argon2 permit nor the authoritative setup lock is available.
            let response =
                tokio::time::timeout(std::time::Duration::from_secs(5), app.oneshot(request))
                    .await
                    .expect("completed setup must not wait for password workers or the setup lock")
                    .unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            let body = to_bytes(response.into_body(), 1024).await.unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                json!({"error": "setup already completed"})
            );
        }
    }
}
