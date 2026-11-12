use super::*;

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateInviteRequest {
    pub email: String,
    pub role: Role,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct InviteResponse {
    pub id: Uuid,
    pub organization_id: Uuid,
    /// Shown once. Send in a URL fragment; never place in a URL path or query.
    pub token: String,
    pub expires_at: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AcceptInviteRequest {
    pub token: String,
    pub email: String,
    #[schema(min_length = 1, max_length = 200)]
    pub name: String,
    /// Required only for a new Account. Existing Accounts must sign in instead.
    #[schema(min_length=12, max_length=1024, format=Password)]
    pub password: Option<String>,
}

// Invalid credentials must never silently downgrade an acceptance to anonymous signup.
pub struct InviteAuth(Option<AccountAuth>);
impl FromRequestParts<AppState> for InviteAuth {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        if parts.headers.contains_key(header::AUTHORIZATION)
            || parts.headers.get_all(header::COOKIE).iter().any(|v| {
                v.to_str().map_or(true, |v| {
                    v.split(';').any(|pair| {
                        pair.trim()
                            .split_once('=')
                            .is_some_and(|(name, _)| name == COOKIE || name == SECURE_COOKIE)
                    })
                })
            })
        {
            Ok(Self(Some(
                AccountAuth::from_request_parts(parts, state).await?,
            )))
        } else {
            Ok(Self(None))
        }
    }
}

#[utoipa::path(post, path="/api/v1/orgs/{org}/invites", request_body=CreateInviteRequest,
    params(("org"=Uuid, Path, description="Organization id")), security(("cookie"=[]),("bearer"=[])),
    responses((status=201, description="Single-use Invite, valid for seven days; token returned once", body=InviteResponse),
    (status=400, description="Invalid input", body=ErrorBody),
    (status=401, description="Account Session ended", body=ErrorBody),
    (status=403, description="forbidden: only Owner/Admin can invite; only Owner can invite Owner", body=ErrorBody),
    (status=404, description="organization_unavailable", body=ErrorBody),
    (status=413, description="Request too large", body=ErrorBody),
    (status=415, description="Expected application/json", body=ErrorBody),
    (status=500, description="Database or random generation failure", body=ErrorBody)))]
pub async fn create_invite(
    State(state): State<AppState>,
    auth: Auth,
    ApiJson(input): ApiJson<CreateInviteRequest>,
) -> Result<Response, ApiError> {
    let email = email(&input.email)?;
    let org = auth.identity.organization.organization_id;
    let mut tx = state.pool.begin().await?;
    members::lock_organization(&mut tx, org).await?;
    members::current_actor(&mut tx, &auth, Action::Invite(input.role)).await?;
    let mut random = [0; 32];
    fill_random(&mut random)?;
    let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let id = Uuid::new_v4();
    let expires_at: String = sqlx::query_scalar("INSERT INTO invites (organization_id,id,email,role,token_hash,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")
        .bind(org).bind(id).bind(email).bind(input.role).bind(Sha256::digest(token.as_bytes()).to_vec()).bind(auth.identity.member.id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(InviteResponse {
            id,
            organization_id: org,
            token,
            expires_at,
        }),
    )
        .into_response())
}

fn invalid_invite() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "invite_unavailable", None)
}

fn unauthorized_issuer() -> ApiError {
    ApiError(StatusCode::FORBIDDEN, "invite_issuer_unauthorized", None)
}

async fn valid_invite(
    connection: &mut sqlx::PgConnection,
    org: Uuid,
    hash: &[u8],
    lock: bool,
) -> Result<(String, Role, Uuid), ApiError> {
    let sql = format!(
        "SELECT email,role,created_by FROM invites WHERE organization_id=$1 AND token_hash=$2 AND accepted_at IS NULL AND expires_at > clock_timestamp(){}",
        if lock { " FOR UPDATE" } else { "" }
    );
    sqlx::query_as(&sql)
        .bind(org)
        .bind(hash)
        .fetch_optional(connection)
        .await?
        .ok_or_else(invalid_invite)
}

#[utoipa::path(post, path="/api/v1/orgs/{org}/invites/accept", request_body=AcceptInviteRequest,
    params(("org"=Uuid, Path, description="Invited Organization id")), security(),
    responses((status=200, description="Invite consumed; Member added or reactivated. Existing Account must be signed in and match Invite email. New Account must sign in afterward", body=Identity),
    (status=400, description="Invalid input or password supplied while signed in", body=ErrorBody),
    (status=401, description="Invalid supplied Account Session", body=ErrorBody),
    (status=403, description="invite_account_mismatch: signed-in Account does not match the invited Account; invite_issuer_unauthorized: issuer is inactive or their current Role cannot issue this Invite", body=ErrorBody),
    (status=404, description="invite_unavailable: unknown, expired, used, foreign Organization or wrong email", body=ErrorBody),
    (status=409, description="invite_sign_in_required for an existing Account; member_already_active for an active Member", body=ErrorBody),
    (status=413, description="Request too large", body=ErrorBody),
    (status=415, description="Expected application/json", body=ErrorBody),
    (status=500, description="Database or password hashing failure", body=ErrorBody)))]
pub async fn accept_invite(
    State(state): State<AppState>,
    InviteAuth(account): InviteAuth,
    path: Result<Path<Uuid>, axum::extract::rejection::PathRejection>,
    ApiJson(input): ApiJson<AcceptInviteRequest>,
) -> Result<Response, ApiError> {
    authorization::require(
        if account.is_some() {
            Actor::Account
        } else {
            Actor::Anonymous
        },
        Action::Public,
        Resource::Global,
    )?;
    let Path(org) = path.map_err(|_| ApiError::bad_request())?;
    if input.token.len() != 64 || !input.token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid_invite());
    }
    let hash = Sha256::digest(input.token.as_bytes()).to_vec();
    let supplied_email = email(&input.email)?;
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 200 || name.contains('\0') {
        return Err(ApiError::bad_request());
    }
    // Validate before expensive hashing, then validate again under the consumption lock.
    let (invited_email, _, _) =
        valid_invite(&mut *state.pool.acquire().await?, org, &hash, false).await?;
    if supplied_email != invited_email {
        return Err(invalid_invite());
    }
    let password_hash = if account.is_none() {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM accounts WHERE email=$1)")
                .bind(&invited_email)
                .fetch_one(&state.pool)
                .await?;
        if exists {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "invite_sign_in_required",
                None,
            ));
        }
        let password = input.password.ok_or_else(ApiError::bad_request)?;
        if password.chars().count() < 12 || password.len() > 1024 {
            return Err(ApiError::bad_request());
        }
        Some(hash_password(password, &PASSWORD_WORKERS).await?)
    } else {
        if input.password.is_some() {
            return Err(ApiError::bad_request());
        }
        None
    };
    let mut tx = state.pool.begin().await?;
    // Order matches Role changes; concurrent acceptances and Owner transitions serialize.
    members::lock_organization(&mut tx, org).await?;
    let (invited_email, role, created_by) = valid_invite(&mut tx, org, &hash, true).await?;
    // The Organization lock fences Role/deactivation writes, including their DB trigger.
    let issuer_role = sqlx::query_scalar::<_, Role>(
        "SELECT role FROM users WHERE organization_id=$1 AND id=$2 AND deactivated_at IS NULL",
    )
    .bind(org)
    .bind(created_by)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(unauthorized_issuer)?;
    authorization::require(
        Actor::Member {
            organization: org,
            role: issuer_role,
            channel_member: false,
            channel_manager: false,
        },
        Action::Invite(role),
        Resource::Organization(org),
    )
    .map_err(|_| unauthorized_issuer())?;
    let account_id = if let Some(account) = account {
        let matches: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM accounts a JOIN account_sessions s ON s.account_id=a.id WHERE a.id=$1 AND a.email=$2 AND s.token_hash=$3 AND s.expires_at>clock_timestamp())")
            .bind(account.account_id).bind(&invited_email).bind(account.token_hash).fetch_one(&mut *tx).await?;
        if !matches {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "invite_account_mismatch",
                None,
            ));
        }
        account.account_id
    } else {
        sqlx::query_scalar("INSERT INTO accounts (id,email,password_hash) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING RETURNING id")
            .bind(Uuid::new_v4()).bind(invited_email).bind(password_hash).fetch_optional(&mut *tx).await?
            .ok_or(ApiError(StatusCode::CONFLICT,"invite_sign_in_required",None))?
    };
    // Reactivation preserves id, revision and history. Historical Channel grants stay stale.
    let (id,name,role) = sqlx::query_as::<_,(Uuid,String,Role)>("INSERT INTO users (organization_id,id,account_id,name,role) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (organization_id,account_id) DO UPDATE SET deactivated_at=NULL,name=EXCLUDED.name,role=EXCLUDED.role WHERE users.deactivated_at IS NOT NULL RETURNING id,name,role")
        .bind(org).bind(Uuid::new_v4()).bind(account_id).bind(name).bind(role).fetch_optional(&mut *tx).await.map_err(members::member_write_error)?
        .ok_or(ApiError(StatusCode::CONFLICT,"member_already_active",None))?;
    // The expiry check is repeated at consumption, so time spent hashing/waiting grants nothing.
    let consumed = sqlx::query("UPDATE invites SET accepted_at=clock_timestamp() WHERE organization_id=$1 AND token_hash=$2 AND accepted_at IS NULL AND expires_at>clock_timestamp()")
        .bind(org).bind(hash).execute(&mut *tx).await?.rows_affected();
    if consumed != 1 {
        return Err(invalid_invite());
    }
    let organization_name =
        sqlx::query_scalar("SELECT name FROM organizations WHERE organization_id=$1")
            .bind(org)
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(Identity {
            organization: Organization {
                organization_id: org,
                name: organization_name,
                capabilities: OrganizationCapabilities::for_member(org, role),
            },
            member: Member { id, name, role },
        }),
    )
        .into_response())
}

#[cfg(test)]
mod tests;
