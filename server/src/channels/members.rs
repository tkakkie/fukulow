use super::*;
use axum::extract::Path;

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AddChannelMemberRequest {
    pub member_id: Uuid,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct ChannelMember {
    pub id: Uuid,
    pub name: String,
    pub role: Role,
    pub manager: bool,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct ChannelMemberList {
    pub members: Vec<ChannelMember>,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ChangeChannelManagerRequest {
    pub manager: bool,
}

#[utoipa::path(get, path="/api/v1/orgs/{org}/channels/{id}/members",
    params(("org"=Uuid,Path),("id"=Uuid,Path)), security(("cookie"=[]),("bearer"=[])),
    responses((status=200,description="Usable Channel grants: Member id, name, Role and manager right; no email",body=ChannelMemberList),
    (status=400,description="Invalid ids",body=ErrorBody),(status=401,description="Account Session ended",body=ErrorBody),
    (status=404,description="organization_unavailable or channel not found",body=ErrorBody),(status=500,description="Database failure",body=ErrorBody)))]
pub async fn list(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid)>, axum::extract::rejection::PathRejection>,
) -> Result<Response, ApiError> {
    let Path((_, channel)) = path.map_err(|_| ApiError::bad_request())?;
    crate::database::organization_read_only(&state.pool, auth.identity.organization.organization_id, async |tx: &mut sqlx::PgConnection| {
        require_visible(&mut *tx, &auth, channel, false).await?;
        let sql = format!(
            "SELECT u.id,u.name,u.role,cm.manager FROM channel_members cm JOIN ({}) u ON u.organization_id=cm.organization_id AND u.id=cm.member_id AND u.membership_revision=cm.membership_revision WHERE cm.organization_id=$1 AND cm.channel_id=$2 ORDER BY u.name,u.id",
            auth::members::ACTIVE_SCOPED_MEMBERS_SQL
        );
        let rows: Vec<(Uuid, String, Role, bool)> = sqlx::query_as(&sql)
            .bind(auth.identity.organization.organization_id)
            .bind(channel)
            .fetch_all(&mut *tx)
            .await?;
        Ok((
            [(header::CACHE_CONTROL, "no-store")],
            Json(ChannelMemberList {
                members: rows
                    .into_iter()
                    .map(|(id, name, role, manager)| ChannelMember { id, name, role, manager })
                    .collect(),
            }),
        )
            .into_response())
    })
    .await
}

#[utoipa::path(post, path="/api/v1/orgs/{org}/channels/{id}/members",request_body=AddChannelMemberRequest,
    params(("org"=Uuid,Path),("id"=Uuid,Path)),security(("cookie"=[]),("bearer"=[])),
    responses((status=204,description="Grant added, renewed, or already current"),
    (status=400,description="Invalid ids or body",body=ErrorBody),(status=401,description="Account Session ended",body=ErrorBody),
    (status=403,description="forbidden: requires Owner/Admin with access or a usable private Channel manager right",body=ErrorBody),
    (status=404,description="organization_unavailable, channel not found or member_not_found",body=ErrorBody),
    (status=413,description="Body too large",body=ErrorBody),(status=415,description="Requires application/json",body=ErrorBody),
    (status=500,description="Database failure",body=ErrorBody)))]
pub async fn add(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid)>, axum::extract::rejection::PathRejection>,
    ApiJson(input): ApiJson<AddChannelMemberRequest>,
) -> Result<Response, ApiError> {
    let Path((_, channel)) = path.map_err(|_| ApiError::bad_request())?;
    mutate(&state, &auth, channel, input.member_id, true).await
}

#[utoipa::path(delete, path="/api/v1/orgs/{org}/channels/{id}/members/{member_id}",
    params(("org"=Uuid,Path),("id"=Uuid,Path),("member_id"=Uuid,Path)),security(("cookie"=[]),("bearer"=[])),
    responses((status=204,description="Grant removed or already absent; every Role may leave"),
    (status=400,description="Invalid ids",body=ErrorBody),(status=401,description="Account Session ended",body=ErrorBody),
    (status=403,description="forbidden: removing others requires Owner/Admin with access or a usable private Channel manager right",body=ErrorBody),
    (status=404,description="organization_unavailable, channel not found or member_not_found",body=ErrorBody),
    (status=409,description="last_channel_manager or last_channel_grant: private Channel protection",body=ErrorBody),
    (status=500,description="Database failure",body=ErrorBody)))]
pub async fn remove(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid, Uuid)>, axum::extract::rejection::PathRejection>,
) -> Result<Response, ApiError> {
    let Path((_, channel, target)) = path.map_err(|_| ApiError::bad_request())?;
    mutate(&state, &auth, channel, target, false).await
}

#[utoipa::path(patch, path="/api/v1/orgs/{org}/channels/{id}/members/{member_id}",request_body=ChangeChannelManagerRequest,
    params(("org"=Uuid,Path),("id"=Uuid,Path),("member_id"=Uuid,Path)),security(("cookie"=[]),("bearer"=[])),
    responses((status=204,description="Manager right updated or already current; grant lifetime and access unchanged"),
    (status=400,description="Invalid input; channel_manager_private_only on public Channels; channel_manager_guest for Guest targets",body=ErrorBody),
    (status=401,description="Account Session ended",body=ErrorBody),
    (status=403,description="forbidden: requires a usable manager, including for no-ops",body=ErrorBody),
    (status=404,description="organization_unavailable, channel not found, member_not_found (unknown/foreign/inactive), or channel_grant_not_found (absent/stale)",body=ErrorBody),
    (status=409,description="last_channel_manager",body=ErrorBody),
    (status=413,description="Body too large",body=ErrorBody),(status=415,description="Requires application/json",body=ErrorBody),
    (status=500,description="Database failure",body=ErrorBody)))]
pub async fn change_manager(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid, Uuid)>, axum::extract::rejection::PathRejection>,
    ApiJson(input): ApiJson<ChangeChannelManagerRequest>,
) -> Result<Response, ApiError> {
    let Path((_, channel, target)) = path.map_err(|_| ApiError::bad_request())?;
    mutate_inner(
        &state,
        &auth,
        channel,
        target,
        Mutation::Manager(input.manager),
    )
    .await
}

enum Mutation {
    Add,
    Remove,
    Manager(bool),
}

async fn require_visible(
    connection: &mut sqlx::PgConnection,
    auth: &Auth,
    channel: Uuid,
    lock: bool,
) -> Result<(), ApiError> {
    let member = (auth.identity.member.id, auth.membership_revision);
    let visible = if lock {
        is_visible_for_write(
            connection,
            auth.identity.organization.organization_id,
            member,
            channel,
        )
        .await?
    } else {
        is_visible(
            connection,
            auth.identity.organization.organization_id,
            member,
            channel,
        )
        .await?
    };
    match visible {
        Some(true) => Ok(()),
        Some(false) => Err(ApiError(StatusCode::NOT_FOUND, "channel not found", None)),
        None => Err(ApiError::organization_unavailable()),
    }
}

pub(super) async fn mutate(
    state: &AppState,
    auth: &Auth,
    channel: Uuid,
    target: Uuid,
    add: bool,
) -> Result<Response, ApiError> {
    mutate_inner(
        state,
        auth,
        channel,
        target,
        if add { Mutation::Add } else { Mutation::Remove },
    )
    .await
}

async fn mutate_inner(
    state: &AppState,
    auth: &Auth,
    channel: Uuid,
    target: Uuid,
    mutation: Mutation,
) -> Result<Response, ApiError> {
    let org = auth.identity.organization.organization_id;
    let changed = crate::database::organization(&state.pool, org, async |tx: &mut sqlx::PgConnection| {
        sqlx::query("SET LOCAL lock_timeout='5s'")
            .execute(&mut *tx)
            .await?;
        // Mutations: Organization -> Channel(s, ascending id) -> Member -> grants
        // -> #142 -> shared #135. Role changes lock all affected private Channels
        // in ascending id before Members; deactivation starts at Organization and
        // never acquires Channels after Members (#237 owns its manager protection).
        // Private creation takes Organization NO KEY UPDATE before creator Member
        // and new rows, keeping the Role guard's Channel set stable through COMMIT.
        // Sends take Member -> grant -> exclusive #135; their FK KEY SHARE locks
        // permit Organization/Channel NO KEY UPDATE, so cannot invert that order.
        // Mark-read releases #135 before Member/grant/position locks; neither path
        // waits back on a mutation's earlier locks.
        auth::members::lock_organization(&mut *tx, org).await?;
        let public: bool=sqlx::query_scalar("SELECT visibility='public' FROM channels WHERE organization_id=$1 AND id=$2 FOR NO KEY UPDATE")
            .bind(org).bind(channel).fetch_optional(&mut *tx).await?.ok_or(ApiError(StatusCode::NOT_FOUND,"channel not found",None))?;
        let actor = auth::members::current_actor(&mut *tx, auth, Action::ReadOrganization).await?;
        // Lock every Member before grants. Defer a missing target's error until the
        // actor has passed authorization, so target validation discloses no access.
        let target_member = auth::members::active_target(&mut *tx, org, target).await;
        // A retained stale self grant proves prior access and may be cleaned up. An
        // absent grant is retryable only while visible: otherwise 204 reveals private
        // Channel existence, so it must match a nonexistent Channel (404).
        let present: Option<i64>=sqlx::query_scalar("SELECT membership_revision FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
            .bind(org).bind(channel).bind(target).fetch_optional(&mut *tx).await?;
        let role = match actor {
            Actor::Member { role, .. } => role,
            _ => return Err(ApiError::forbidden()),
        };
        let grant: Option<bool> = sqlx::query_scalar("SELECT manager FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 AND membership_revision=$4 FOR SHARE")
            .bind(org).bind(channel).bind(auth.identity.member.id).bind(auth.membership_revision).fetch_optional(&mut *tx).await?;
        let actor = Actor::Member {
            organization: org,
            role,
            channel_member: grant.is_some()
                || (matches!(mutation, Mutation::Remove)
                    && target == auth.identity.member.id
                    && present.is_some()),
            channel_manager: grant.unwrap_or(false),
        };
        let resource = Resource::Channel {
            organization: org,
            public,
        };
        if !authorize(actor, Action::ReadChannel, resource).allowed {
            return Err(ApiError(StatusCode::NOT_FOUND, "channel not found", None));
        }
        if matches!(mutation, Mutation::Manager(_)) && public {
            // Require the ordinary management policy first, even for invalid targets/no-ops.
            auth::authorization::require(actor, Action::AddChannelMembers, resource)?;
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "channel_manager_private_only",
                None,
            ));
        }
        auth::authorization::require(
            actor,
            match mutation {
                Mutation::Add => Action::AddChannelMembers,
                Mutation::Manager(_) => Action::ManageChannelManagers,
                Mutation::Remove if target == auth.identity.member.id => Action::LeaveChannel,
                Mutation::Remove => Action::RemoveChannelMembers,
            },
            resource,
        )?;
        let (member, revision) = target_member?;
        let changed = if let Mutation::Manager(value) = mutation {
            if member.role == Role::Guest {
                return Err(ApiError(
                    StatusCode::BAD_REQUEST,
                    "channel_manager_guest",
                    None,
                ));
            }
            let current: bool = sqlx::query_scalar("SELECT manager FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 AND membership_revision=$4 FOR UPDATE")
                .bind(org).bind(channel).bind(target).bind(revision).fetch_optional(&mut *tx).await?
                .ok_or(ApiError(StatusCode::NOT_FOUND, "channel_grant_not_found", None))?;
            if current != value {
                if !value {
                    protect(&mut *tx, org, &[channel], target, false, None, true).await?;
                }
                sqlx::query("UPDATE channel_members SET manager=$4 WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                    .bind(org).bind(channel).bind(target).bind(value).execute(&mut *tx).await?;
            }
            false // The right changes no access, Unread, grant_id or subscription.
        } else if matches!(mutation, Mutation::Add) {
            sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id,membership_revision) VALUES ($1,$2,$3,$4) ON CONFLICT (organization_id,channel_id,member_id) DO UPDATE SET membership_revision=EXCLUDED.membership_revision,grant_id=gen_random_uuid(),manager=false WHERE channel_members.membership_revision<>EXCLUDED.membership_revision")
                .bind(org).bind(channel).bind(target).bind(revision).execute(&mut *tx).await?.rows_affected() > 0
        } else {
            // Stale grants contribute nothing to the usable-grant/manager counts.
            if !public && present == Some(revision) {
                protect(&mut *tx, org, &[channel], target, true, None, false).await?;
            }
            sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                .bind(org).bind(channel).bind(target).execute(&mut *tx).await?.rows_affected() > 0
        };
        Ok::<_, ApiError>(changed)
    }).await?;
    if changed {
        state
            .session_changes
            .recheck_subscriptions(&state.pool, auth::SubscriptionScope::Channel(org, channel))
            .await;
    }
    Ok((
        StatusCode::NO_CONTENT,
        [(header::CACHE_CONTROL, "no-store")],
    )
        .into_response())
}

async fn protect(
    connection: &mut sqlx::PgConnection,
    org: Uuid,
    channels: &[Uuid],
    target: Uuid,
    remove_grant: bool,
    role: Option<Role>,
    revoke: bool,
) -> Result<(), ApiError> {
    let before = manager_sql("u.role", "cm.manager");
    let after = manager_sql(
        "(CASE WHEN u.id=$3 THEN COALESCE($4::text,u.role) ELSE u.role END)",
        "(cm.manager AND NOT (u.id=$3 AND $5))",
    );
    let sql = format!(
        "SELECT count(*) FILTER (WHERE {before}),count(*) FILTER (WHERE u.id<>$3),count(*) FILTER (WHERE (NOT $6 OR u.id<>$3) AND ({after})) FROM channel_members cm JOIN ({}) u ON u.organization_id=cm.organization_id AND u.id=cm.member_id AND u.membership_revision=cm.membership_revision WHERE cm.organization_id=$1 AND cm.channel_id=ANY($2) GROUP BY cm.channel_id",
        auth::members::ACTIVE_SCOPED_MEMBERS_SQL
    );
    let counts: Vec<(i64, i64, i64)> = sqlx::query_as(&sql)
        .bind(org)
        .bind(channels)
        .bind(target)
        .bind(role)
        .bind(revoke)
        .bind(remove_grant)
        .fetch_all(connection)
        .await?;
    for (managers, remaining, remaining_managers) in counts {
        if remove_grant && remaining == 0 {
            return Err(ApiError(StatusCode::CONFLICT, "last_channel_grant", None));
        }
        if managers > 0 && remaining_managers == 0 {
            return Err(ApiError(StatusCode::CONFLICT, "last_channel_manager", None));
        }
    }
    Ok(())
}

// SQL is a projection of authorize over all Roles and both right values.
// The guard substitutes the proposed Role/right; removal excludes the grant.
fn manager_sql(role: &str, right: &str) -> String {
    let without = auth::authorization::channel_manager_roles_sql(false);
    let with = auth::authorization::channel_manager_roles_sql(true);
    format!("((NOT {right} AND {role} IN ({without})) OR ({right} AND {role} IN ({with})))")
}

pub struct RoleChangeGuard(Vec<Uuid>);

impl auth::members::RoleChangeGuard for RoleChangeGuard {
    async fn lock(
        connection: &mut sqlx::PgConnection,
        organization: Uuid,
        target: Uuid,
    ) -> Result<Self, ApiError> {
        // Private creation and grant mutations share Organization serialization;
        // lock before current_actor takes its Member lock, even for self changes.
        let channels = sqlx::query_scalar("SELECT c.id FROM channels c WHERE c.organization_id=$1 AND c.visibility='private' AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.organization_id=c.organization_id AND cm.channel_id=c.id AND cm.member_id=$2) ORDER BY c.id FOR NO KEY UPDATE OF c")
            .bind(organization).bind(target).fetch_all(connection).await?;
        Ok(Self(channels))
    }

    async fn check(
        &self,
        connection: &mut sqlx::PgConnection,
        organization: Uuid,
        target: Uuid,
        role: Role,
    ) -> Result<(), ApiError> {
        auth::members::active_target(connection, organization, target).await?;
        protect(
            connection,
            organization,
            &self.0,
            target,
            false,
            Some(role),
            role == Role::Guest,
        )
        .await?;
        if role == Role::Guest {
            sqlx::query("UPDATE channel_members SET manager=false WHERE organization_id=$1 AND member_id=$2 AND channel_id=ANY($3) AND manager")
                .bind(organization).bind(target).bind(&self.0).execute(connection).await?;
        }
        Ok(())
    }
}
