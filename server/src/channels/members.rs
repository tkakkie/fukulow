use super::*;
use axum::extract::Path;

mod manager_guard;

pub use manager_guard::RoleChangeGuard;
use manager_guard::{ManagerChange, protect};

pub struct MemberListVisibility;

impl auth::members::MemberListVisibility for MemberListVisibility {
    fn shared_channel_sql() -> String {
        let visible = visible_channel_sql();
        format!(
            "SELECT 1 FROM channels c JOIN channel_members shared ON \
             shared.organization_id=c.organization_id AND shared.channel_id=c.id \
             AND shared.member_id=m.id AND shared.membership_revision=m.membership_revision \
             WHERE c.organization_id=$1 AND ({visible})"
        )
    }
}

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
    (status=400,description="Invalid ids; accessible DMs refuse dm_membership_fixed",body=ErrorBody),(status=401,description="Account Session ended",body=ErrorBody),
    (status=404,description="organization_unavailable or channel not found",body=ErrorBody),(status=500,description="Database failure",body=ErrorBody)))]
pub async fn list(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid)>, axum::extract::rejection::PathRejection>,
) -> Result<Response, ApiError> {
    let Path((_, channel)) = path.map_err(|_| ApiError::bad_request())?;
    crate::database::organization_read_only(&state.pool, auth.identity.organization.organization_id, async |tx: &mut sqlx::PgConnection| {
        require_visible(&mut *tx, &auth, channel, false).await?;
        dms::reject_membership(tx,auth.identity.organization.organization_id,channel).await?;
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
    (status=400,description="Invalid ids or body; accessible DMs refuse dm_membership_fixed",body=ErrorBody),(status=401,description="Account Session ended",body=ErrorBody),
    (status=403,description="forbidden: requires Owner/Admin with access or a usable private Channel manager right",body=ErrorBody),
    (status=404,description="organization_unavailable, channel not found or member_not_found",body=ErrorBody),
    (status=413,description="Body too large",body=ErrorBody),(status=415,description="Requires application/json",body=ErrorBody),
    (status=500,description="Database failure",body=ErrorBody),
    (status=503,description="lock_contention on a lock timeout (no Retry-After)",body=ErrorBody)))]
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
    (status=500,description="Database failure",body=ErrorBody),
    (status=503,description="lock_contention on a lock timeout (no Retry-After)",body=ErrorBody)))]
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
    (status=400,description="Invalid input; channel_manager_private_only on public Channels; channel_manager_guest for Guest targets; accessible DMs refuse dm_membership_fixed",body=ErrorBody),
    (status=401,description="Account Session ended",body=ErrorBody),
    (status=403,description="forbidden: requires a usable manager, including for no-ops",body=ErrorBody),
    (status=404,description="organization_unavailable, channel not found, member_not_found (unknown/foreign/inactive), or channel_grant_not_found (absent/stale)",body=ErrorBody),
    (status=409,description="last_channel_manager",body=ErrorBody),
    (status=413,description="Body too large",body=ErrorBody),(status=415,description="Requires application/json",body=ErrorBody),
    (status=500,description="Database failure",body=ErrorBody),
    (status=503,description="lock_contention on a lock timeout (no Retry-After)",body=ErrorBody)))]
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

#[derive(Clone, Copy)]
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
        Some(false) => Err(ApiError::channel_not_found()),
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
    let state = state.clone();
    let auth = auth.clone();
    tokio::spawn(async move {
        let (changed, notice) = crate::database::organization_confirming_rollback(
            &state.pool,
            org,
            ApiError::is_lock_contention,
            async |tx: &mut sqlx::PgConnection| {
                mutate_body(tx, &state, &auth, channel, target, mutation)
                    .await
                    .map_err(ApiError::classify_write_contention)
            },
        )
        .await?;
        if changed {
            let mut notice = notice;
            if let Some(notice) = notice.as_mut() {
                notice.retire();
            }
            if !matches!(mutation, Mutation::Manager(_)) {
                state
                    .session_changes
                    .recheck_subscriptions(
                        &state.pool,
                        auth::SubscriptionScope::Channel(org, channel),
                    )
                    .await;
            }
            // The mutation's recheck must not fence its fresh, still-unproved notice queries.
            if let Some(notice) = notice {
                notice.committed(state.pool.clone());
            }
            state.session_changes.channel_changed(
                state.pool.clone(),
                org,
                auth::activity::ChannelChange::Members { channel },
            );
        }
        Ok::<_, ApiError>(())
    })
    .await??;
    Ok((
        StatusCode::NO_CONTENT,
        [(header::CACHE_CONTROL, "no-store")],
    )
        .into_response())
}

async fn mutate_body(
    tx: &mut sqlx::PgConnection,
    state: &AppState,
    auth: &Auth,
    channel: Uuid,
    target: Uuid,
    mutation: Mutation,
) -> Result<(bool, Option<Box<dyn auth::activity::ActivityChange>>), ApiError> {
    let org = auth.identity.organization.organization_id;
    sqlx::query(crate::database::LOCK_TIMEOUT_SQL)
        .execute(&mut *tx)
        .await?;
    // Mutations: Organization -> Channel(s, ascending id) -> Member -> grants
    // -> #142 -> shared #135. Role changes lock all affected private Channels
    // and deactivation lock in ascending id before Members.
    // Private creation takes Organization NO KEY UPDATE before creator Member
    // and new rows, keeping the Role guard's Channel set stable through COMMIT.
    // Sends take Member -> grant -> exclusive #135; their FK KEY SHARE locks
    // permit Organization/Channel NO KEY UPDATE, so cannot invert that order.
    // Mark-read releases #135 before Member/grant/position locks; neither path
    // waits back on a mutation's earlier locks.
    auth::members::lock_organization(&mut *tx, org).await?;
    let (public, is_dm): (bool, bool) = sqlx::query_as("SELECT COALESCE(visibility='public',false),kind='dm' FROM channels WHERE organization_id=$1 AND id=$2 FOR NO KEY UPDATE")
            .bind(org).bind(channel).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::channel_not_found)?;
    let actor = auth::members::current_actor(&mut *tx, auth, Action::ReadOrganization).await?;
    if is_dm {
        require_visible(tx, auth, channel, true).await?;
        return Err(dms::membership_fixed());
    }
    // Lock every Member before grants. Defer a missing target's error until the
    // actor has passed authorization, so target validation discloses no access.
    let target_member = auth::members::active_target(&mut *tx, org, target).await?;
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
        return Err(ApiError::channel_not_found());
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
    let (member, revision) = target_member.ok_or_else(ApiError::member_not_found)?;
    let notice = state
        .session_changes
        .capture_activity(
            tx,
            org,
            target,
            auth::activity::ChangeScope::Channel(channel),
        )
        .await?;
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
                protect(
                    &mut *tx,
                    org,
                    &[channel],
                    target,
                    ManagerChange::RevokeRight,
                )
                .await?;
            }
            sqlx::query("UPDATE channel_members SET manager=$4 WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                    .bind(org).bind(channel).bind(target).bind(value).execute(&mut *tx).await?;
        }
        current != value // The right changes no access, Unread, grant_id or subscription.
    } else if matches!(mutation, Mutation::Add) {
        sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id,membership_revision) VALUES ($1,$2,$3,$4) ON CONFLICT (organization_id,channel_id,member_id) DO UPDATE SET membership_revision=EXCLUDED.membership_revision,grant_id=gen_random_uuid(),manager=false WHERE channel_members.membership_revision<>EXCLUDED.membership_revision")
                .bind(org).bind(channel).bind(target).bind(revision).execute(&mut *tx).await?.rows_affected() > 0
    } else {
        // Stale grants contribute nothing to the usable-grant/manager counts.
        if !public && present == Some(revision) {
            protect(
                &mut *tx,
                org,
                &[channel],
                target,
                ManagerChange::RemoveGrant,
            )
            .await?;
        }
        sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                .bind(org).bind(channel).bind(target).execute(&mut *tx).await?.rows_affected() > 0
    };
    Ok((changed, notice))
}
