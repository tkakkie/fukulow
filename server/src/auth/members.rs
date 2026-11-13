use super::*;

#[derive(Serialize, Deserialize, ToSchema)]
pub struct MemberList {
    pub members: Vec<Member>,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ChangeRoleRequest {
    pub role: Role,
}

/// The composition root supplies Channel-owned protection without auth depending
/// on channels. Both phases run under the Organization lock through COMMIT.
pub trait RoleChangeGuard: Sized {
    fn check_deactivation(
        &self,
        connection: &mut sqlx::PgConnection,
        organization: Uuid,
        target: Uuid,
    ) -> impl std::future::Future<Output = Result<(), ApiError>> + Send;

    fn lock(
        connection: &mut sqlx::PgConnection,
        organization: Uuid,
        target: Uuid,
    ) -> impl std::future::Future<Output = Result<Self, ApiError>> + Send;

    fn check(
        &self,
        connection: &mut sqlx::PgConnection,
        organization: Uuid,
        target: Uuid,
        role: Role,
    ) -> impl std::future::Future<Output = Result<(), ApiError>> + Send;
}

pub(crate) async fn lock_organization(
    tx: &mut sqlx::PgConnection,
    organization: Uuid,
) -> Result<(), ApiError> {
    sqlx::query(
        "SELECT organization_id FROM organizations WHERE organization_id=$1 FOR NO KEY UPDATE",
    )
    .bind(organization)
    .fetch_optional(tx)
    .await?
    .ok_or_else(ApiError::organization_unavailable)?;
    Ok(())
}

pub(crate) async fn current_actor(
    connection: &mut sqlx::PgConnection,
    auth: &Auth,
    action: Action,
) -> Result<Actor, ApiError> {
    let sql = format!("SELECT role FROM ({}) u", current_member_sql(true));
    let organization = auth.identity.organization.organization_id;
    let role: Role = sqlx::query_scalar(&sql)
        .bind(organization)
        .bind(auth.identity.member.id)
        .bind(auth.membership_revision)
        .fetch_optional(connection)
        .await?
        .ok_or_else(ApiError::organization_unavailable)?;
    let actor = Actor::Member {
        organization,
        role,
        channel_member: false,
        channel_manager: false,
    };
    authorization::require(actor, action, Resource::Organization(organization))?;
    Ok(actor)
}

#[utoipa::path(get, path = "/api/v1/orgs/{org}/members",
    params(("org" = Uuid, Path, description = "Organization id")),
    security(("cookie"=[]), ("bearer"=[])),
    responses((status=200, description="Active Members; no Account emails or credentials", body=MemberList),
    (status=400, description="Invalid Organization id", body=ErrorBody),
    (status=401, description="Account Session ended", body=ErrorBody),
    (status=404, description="organization_unavailable", body=ErrorBody),
    (status=500, description="Database failure", body=ErrorBody)))]
pub async fn list_members(State(state): State<AppState>, auth: Auth) -> Result<Response, ApiError> {
    auth.require(Action::ReadOrganization)?;
    // One statement keeps authorization and results in one non-locking snapshot.
    let sql = format!(
        "SELECT m.id,m.name,m.role,u.role FROM ({}) u JOIN users m ON m.organization_id=$1 AND m.deactivated_at IS NULL ORDER BY m.name,m.id",
        current_member_sql(false)
    );
    let rows = crate::database::organization_read_only(
        &state.pool,
        auth.identity.organization.organization_id,
        async |tx: &mut sqlx::PgConnection| {
            sqlx::query_as::<_, (Uuid, String, Role, Role)>(&sql)
                .bind(auth.identity.organization.organization_id)
                .bind(auth.identity.member.id)
                .bind(auth.membership_revision)
                .fetch_all(tx)
                .await
        },
    )
    .await?;
    let role = rows
        .first()
        .map(|row| row.3)
        .ok_or_else(ApiError::organization_unavailable)?;
    authorization::require(
        Actor::Member {
            organization: auth.identity.organization.organization_id,
            role,
            channel_member: false,
            channel_manager: false,
        },
        Action::ReadOrganization,
        Resource::Organization(auth.identity.organization.organization_id),
    )?;
    let members = rows
        .into_iter()
        .map(|(id, name, role, _)| Member { id, name, role })
        .collect();
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(MemberList { members }),
    )
        .into_response())
}

#[utoipa::path(patch, path = "/api/v1/orgs/{org}/members/{id}/role", request_body=ChangeRoleRequest,
    params(("org" = Uuid, Path, description = "Organization id"), ("id"=Uuid, Path, description="Member id")),
    security(("cookie"=[]), ("bearer"=[])),
    responses((status=200, description="Updated active Member; only Owners can change Roles", body=Member),
    (status=400, description="Invalid input", body=ErrorBody),
    (status=401, description="Account Session ended", body=ErrorBody),
    (status=403, description="forbidden: caller is not an Owner", body=ErrorBody),
    (status=404, description="organization_unavailable or member_not_found", body=ErrorBody),
    (status=409, description="last_owner: the last active Owner cannot be demoted (takes precedence over last_channel_manager); last_channel_manager: a private Channel cannot lose its last usable manager (no Channel details)", body=ErrorBody),
    (status=413, description="Request too large", body=ErrorBody),
    (status=415, description="Expected application/json", body=ErrorBody),
    (status=500, description="Database failure", body=ErrorBody)))]
pub async fn change_role<G: RoleChangeGuard>(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid)>, axum::extract::rejection::PathRejection>,
    ApiJson(input): ApiJson<ChangeRoleRequest>,
) -> Result<Response, ApiError> {
    let Path((org, id)) = path.map_err(|_| ApiError::bad_request())?;
    let row = crate::database::organization(&state.pool, auth.identity.organization.organization_id, async |tx: &mut sqlx::PgConnection| {
        lock_organization(&mut *tx, org).await?;
        let guard = G::lock(&mut *tx, org, id).await?;
        current_actor(&mut *tx, &auth, Action::ChangeRole).await?;
        if input.role != Role::Owner {
            let last_owner: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM users WHERE organization_id=$1 AND id=$2 AND role='owner' AND deactivated_at IS NULL)
                 AND NOT EXISTS (SELECT 1 FROM users WHERE organization_id=$1 AND id<>$2 AND role='owner' AND deactivated_at IS NULL)",
            )
            .bind(org)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            if last_owner {
                return Err(ApiError(StatusCode::CONFLICT, "last_owner", None));
            }
        }
        guard.check(&mut *tx, org, id, input.role).await?;
        let row = sqlx::query_as::<_,(Uuid,String,Role)>("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2 AND deactivated_at IS NULL RETURNING id,name,role")
            .bind(org).bind(id).bind(input.role).fetch_optional(&mut *tx).await.map_err(member_write_error)?
            .ok_or(ApiError(StatusCode::NOT_FOUND,"member_not_found",None))?;
        Ok::<_, ApiError>(row)
    }).await?;
    state
        .session_changes
        .recheck_subscriptions(&state.pool, SubscriptionScope::Member(org, id))
        .await;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(Member {
            id: row.0,
            name: row.1,
            role: row.2,
        }),
    )
        .into_response())
}

pub(crate) fn member_write_error(error: sqlx::Error) -> ApiError {
    if error
        .as_database_error()
        .is_some_and(|e| e.constraint() == Some("users_last_owner"))
    {
        ApiError(StatusCode::CONFLICT, "last_owner", None)
    } else {
        error.into()
    }
}

// Batched Channel fallback composes this projection; auth retains table ownership.
pub(crate) const ACTIVE_SCOPED_MEMBERS_SQL: &str = "SELECT organization_id,id,name,role,membership_revision FROM users WHERE deactivated_at IS NULL";

pub(crate) async fn active_target(
    connection: &mut sqlx::PgConnection,
    organization: Uuid,
    id: Uuid,
) -> Result<(Member, i64), ApiError> {
    // Guest changes clear Channel rights before updating Role. Exclude new
    // sends' Member SHARE locks now, before taking any grant UPDATE lock.
    let row: (String,Role,i64) = sqlx::query_as("SELECT name,role,membership_revision FROM users WHERE organization_id=$1 AND id=$2 AND deactivated_at IS NULL FOR NO KEY UPDATE")
        .bind(organization).bind(id).fetch_optional(connection).await?.ok_or(ApiError(StatusCode::NOT_FOUND,"member_not_found",None))?;
    Ok((
        Member {
            id,
            name: row.0,
            role: row.1,
        },
        row.2,
    ))
}

#[utoipa::path(post, path = "/api/v1/orgs/{org}/members/{id}/deactivate",
    params(("org" = Uuid, Path, description = "Organization id"), ("id"=Uuid, Path, description="Member id, not Account id")),
    security(("cookie"=[]), ("bearer"=[])),
    responses((status=204, description="Member deactivated; no body. Authorship and Account Sessions retained; revision incremented, old grants/rights unusable"),
    (status=400, description="Invalid ids", body=ErrorBody),
    (status=401, description="Authentication required (first check)", body=ErrorBody),
    (status=403, description="forbidden: base authorization requires Owner/Admin before target lookup; after lookup self-deactivation and Admin on Owner are forbidden, ahead of last_owner", body=ErrorBody),
    (status=404, description="Caller Membership organization_unavailable precedes authorization; then unknown, foreign or already inactive target member_not_found, including repeat requests", body=ErrorBody),
    (status=409, description="last_owner precedes last_channel_manager; a managed private Channel cannot lose its last usable manager (active/current Owner/Admin grant or Channel manager right). Public/unmanaged Channels excepted; no Channel details. Every denial leaves state unchanged", body=ErrorBody),
    (status=500, description="Database failure", body=ErrorBody)))]
pub async fn deactivate<G: RoleChangeGuard + Send + 'static>(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid)>, axum::extract::rejection::PathRejection>,
) -> Result<Response, ApiError> {
    let Path((org, id)) = path.map_err(|_| ApiError::bad_request())?;
    // Own COMMIT and signaling together, even if the HTTP future is cancelled.
    tokio::spawn(async move {
        let (account, revision) = deactivate_transaction::<G>(&state.pool, &auth, org, id).await?;
        state
            .session_changes
            .membership_revoked(org, account, revision);
        state
            .session_changes
            .recheck_subscriptions(&state.pool, SubscriptionScope::Member(org, id))
            .await;
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

async fn deactivate_transaction<G: RoleChangeGuard>(
    pool: &sqlx::PgPool,
    auth: &Auth,
    org: Uuid,
    id: Uuid,
) -> Result<(Uuid, i64), ApiError> {
    crate::database::organization(pool, org, async |tx: &mut sqlx::PgConnection| {
        lock_organization(tx, org).await?;
        let guard = G::lock(tx, org, id).await?;
        let actor = current_actor(tx, auth, Action::DeactivateMember).await?;
        let (target, _) = active_target(tx, org, id).await?;
        authorization::require(actor, Action::DeactivateMember, Resource::Member {
            organization: org, role: target.role, is_self: id == auth.identity.member.id,
        })?;
        if target.role == Role::Owner {
            let other_owner: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE organization_id=$1 AND id<>$2 AND role='owner' AND deactivated_at IS NULL)")
                .bind(org).bind(id).fetch_one(&mut *tx).await?;
            if !other_owner {
                return Err(ApiError(StatusCode::CONFLICT, "last_owner", None));
            }
        }
        guard.check_deactivation(tx, org, id).await?;
        // Route ids are Member ids. Resolve the Account only in this scoped UPDATE.
        sqlx::query_as("UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND deactivated_at IS NULL RETURNING account_id,membership_revision")
            .bind(org).bind(id).fetch_one(tx).await.map_err(member_write_error)
    }).await
}
