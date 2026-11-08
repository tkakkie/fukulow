use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json,
    extract::{FromRequestParts, State},
    http::{HeaderMap, StatusCode, header, request::Parts},
    response::{IntoResponse, Response},
};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use subtle::ConstantTimeEq;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::AppState;

// Bound Argon2 memory/CPU work independently from Tokio blocking-thread capacity.
static PASSWORD_WORKERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

const COOKIE: &str = "fukulow_session";
const SESSION_SECONDS: u32 = 30 * 24 * 60 * 60;

#[derive(Debug, Serialize, ToSchema)]
pub struct ErrorBody {
    pub error: String,
}

pub struct ApiError(StatusCode, &'static str);
impl ApiError {
    fn unauthorized() -> Self {
        Self(StatusCode::UNAUTHORIZED, "invalid credentials")
    }
    fn bad_request() -> Self {
        Self(StatusCode::BAD_REQUEST, "invalid input")
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
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        response
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        eprintln!("database operation failed: {error}");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
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

async fn hash_password(password: String) -> Result<String, ApiError> {
    let permit = PASSWORD_WORKERS.acquire().await.unwrap();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|hash| hash.to_string())
    })
    .await
    .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error"))?
    .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error"))
}

#[utoipa::path(post, path = "/api/v1/setup", request_body = SetupRequest,
    responses((status = 201, body = Identity), (status = 400, body = ErrorBody),
    (status = 401, description = "Missing or invalid setup token", body = ErrorBody),
    (status = 409, description = "Setup already completed", body = ErrorBody)))]
pub async fn setup(
    State(state): State<AppState>,
    Json(input): Json<SetupRequest>,
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
    let password_hash = hash_password(input.password).await?;
    let mut tx = state.pool.begin().await?;
    // Global bootstrap is the sole tenant-scope exception. The table lock also
    // serializes setup across processes and concurrent first requests.
    sqlx::query("LOCK TABLE organizations IN EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await?;
    if sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM organizations)")
        .fetch_one(&mut *tx)
        .await?
    {
        return Err(ApiError(StatusCode::CONFLICT, "setup already completed"));
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

#[utoipa::path(post, path = "/api/v1/session", request_body = SignInRequest,
    responses((status = 200, body = SessionResponse, headers(("Set-Cookie" = String, description = "HttpOnly; SameSite=Strict; Path=/; Secure by default"))),
    (status = 400, body = ErrorBody), (status = 401, body = ErrorBody)))]
pub async fn sign_in(
    State(state): State<AppState>,
    Json(input): Json<SignInRequest>,
) -> Result<Response, ApiError> {
    let email = email(&input.email)?;
    if input.password.is_empty() || input.password.len() > 1024 {
        return Err(ApiError::bad_request());
    }
    let organization_id = match input.organization_id {
        Some(id) => id,
        None => {
            // Discover only whether there is a sole tenant; member lookup stays scoped.
            let organizations =
                sqlx::query_scalar::<_, Uuid>("SELECT organization_id FROM organizations LIMIT 2")
                    .fetch_all(&state.pool)
                    .await?;
            let [id] = organizations.as_slice() else {
                return Err(ApiError::bad_request());
            };
            *id
        }
    };
    let stored = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id, password_hash FROM users WHERE organization_id = $1 AND email = $2",
    )
    .bind(organization_id)
    .bind(email)
    .fetch_optional(&state.pool)
    .await?;
    let (user_id, password_hash) = match stored {
        Some(value) => value,
        None => {
            // Spend the same Argon2 work for an unknown organization/email.
            hash_password(input.password).await?;
            return Err(ApiError::unauthorized());
        }
    };
    let permit = PASSWORD_WORKERS.acquire().await.unwrap();
    let valid = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        PasswordHash::new(&password_hash).is_ok_and(|hash| {
            Argon2::default()
                .verify_password(input.password.as_bytes(), &hash)
                .is_ok()
        })
    })
    .await
    .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "internal error"))?;
    if !valid {
        return Err(ApiError::unauthorized());
    }
    let mut random = [0u8; 32];
    OsRng.fill_bytes(&mut random);
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
            .unwrap()
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
    responses((status = 200, body = Identity), (status = 401, body = ErrorBody)))]
pub async fn me(auth: Auth) -> impl IntoResponse {
    ([(header::CACHE_CONTROL, "no-store")], Json(auth.identity))
}

#[utoipa::path(delete, path = "/api/v1/session", security(("cookie" = []), ("bearer" = [])),
    responses((status = 204, description = "Session revoked and cookie cleared", headers(("Set-Cookie" = String))), (status = 401, body = ErrorBody)))]
pub async fn sign_out(State(state): State<AppState>, auth: Auth) -> Result<Response, ApiError> {
    sqlx::query("DELETE FROM sessions WHERE organization_id = $1 AND token_hash = $2")
        .bind(auth.identity.organization.organization_id)
        .bind(auth.token_hash)
        .execute(&state.pool)
        .await?;
    Ok((
        StatusCode::NO_CONTENT,
        [
            (header::SET_COOKIE, cookie(&state, "", 0)),
            (header::CACHE_CONTROL, "no-store".into()),
        ],
    )
        .into_response())
}
