use super::*;
use axum::extract::Path;

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AddChannelMemberRequest {
    pub member_id: Uuid,
}

#[utoipa::path(get, path="/api/v1/orgs/{org}/channels/{id}/members",
    params(("org"=Uuid,Path),("id"=Uuid,Path)), security(("cookie"=[]),("bearer"=[])),
    responses((status=200,description="Usable Channel grants: Member id, name and Role only",body=auth::members::MemberList),
    (status=400,description="Invalid ids",body=ErrorBody),(status=401,description="Account Session ended",body=ErrorBody),
    (status=404,description="organization_unavailable or channel not found",body=ErrorBody),(status=500,description="Database failure",body=ErrorBody)))]
pub async fn list(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid)>, axum::extract::rejection::PathRejection>,
) -> Result<Response, ApiError> {
    let Path((org, channel)) = path.map_err(|_| ApiError::bad_request())?;
    let mut tx = state
        .pool
        .begin_with("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .await?;
    require_visible(&mut tx, &auth, channel, false).await?;
    let sql = format!(
        "SELECT u.id,u.name,u.role FROM channel_members cm JOIN ({}) u ON u.organization_id=cm.organization_id AND u.id=cm.member_id AND u.membership_revision=cm.membership_revision WHERE cm.organization_id=$1 AND cm.channel_id=$2 ORDER BY u.name,u.id",
        auth::members::ACTIVE_SCOPED_MEMBERS_SQL
    );
    let rows: Vec<(Uuid, String, Role)> = sqlx::query_as(&sql)
        .bind(org)
        .bind(channel)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(auth::members::MemberList {
            members: rows
                .into_iter()
                .map(|(id, name, role)| auth::Member { id, name, role })
                .collect(),
        }),
    )
        .into_response())
}

#[utoipa::path(post, path="/api/v1/orgs/{org}/channels/{id}/members",request_body=AddChannelMemberRequest,
    params(("org"=Uuid,Path),("id"=Uuid,Path)),security(("cookie"=[]),("bearer"=[])),
    responses((status=204,description="Grant added, renewed, or already current"),
    (status=400,description="Invalid ids or body",body=ErrorBody),(status=401,description="Account Session ended",body=ErrorBody),
    (status=403,description="forbidden: requires Owner/Admin with Channel access",body=ErrorBody),
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
    (status=403,description="forbidden: removing others requires Owner/Admin with access",body=ErrorBody),
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
    let org = auth.identity.organization.organization_id;
    let mut tx = state.pool.begin().await?;
    sqlx::query("SET LOCAL lock_timeout='5s'")
        .execute(&mut *tx)
        .await?;
    // API mutations serialize Organization -> actor Member -> Channel -> grants
    // -> #142 Unread serialization -> shared #135 baseline. Sends/mark-read take
    // Member -> grant; sends then take exclusive #135, mark-read its position.
    auth::members::lock_organization(&mut tx, org).await?;
    let actor = auth::members::current_actor(&mut tx, auth, Action::ReadOrganization).await?;
    let public: bool=sqlx::query_scalar("SELECT visibility='public' FROM channels WHERE organization_id=$1 AND id=$2 FOR NO KEY UPDATE")
        .bind(org).bind(channel).fetch_optional(&mut *tx).await?.ok_or(ApiError(StatusCode::NOT_FOUND,"channel not found",None))?;
    // An absent self-removal remains retryable after losing the private grant.
    // It still needs current Organization Membership and an active self target.
    let present: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3)")
        .bind(org).bind(channel).bind(target).fetch_one(&mut *tx).await?;
    if !add && target == auth.identity.member.id && !present {
        tx.commit().await?;
        return Ok((
            StatusCode::NO_CONTENT,
            [(header::CACHE_CONTROL, "no-store")],
        )
            .into_response());
    }
    require_visible(&mut tx, auth, channel, true).await?;
    let role = match actor {
        Actor::Member { role, .. } => role,
        _ => return Err(ApiError::forbidden()),
    };
    auth::authorization::require(
        Actor::Member {
            organization: org,
            role,
            channel_member: true,
        },
        if add {
            Action::AddChannelMembers
        } else if target == auth.identity.member.id {
            Action::LeaveChannel
        } else {
            Action::RemoveChannelMembers
        },
        Resource::Channel {
            organization: org,
            public,
        },
    )?;
    let (_, revision) = auth::members::active_target(&mut tx, org, target).await?;
    if add {
        sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id,membership_revision) VALUES ($1,$2,$3,$4) ON CONFLICT (organization_id,channel_id,member_id) DO UPDATE SET membership_revision=EXCLUDED.membership_revision,grant_id=gen_random_uuid() WHERE channel_members.membership_revision<>EXCLUDED.membership_revision")
            .bind(org).bind(channel).bind(target).bind(revision).execute(&mut *tx).await?;
    } else {
        if !public && present {
            protect(&mut tx, org, channel, target).await?;
        }
        sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
            .bind(org).bind(channel).bind(target).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    state
        .session_changes
        .recheck_subscriptions(&state.pool)
        .await;
    Ok((
        StatusCode::NO_CONTENT,
        [(header::CACHE_CONTROL, "no-store")],
    )
        .into_response())
}

async fn protect(
    connection: &mut sqlx::PgConnection,
    org: Uuid,
    channel: Uuid,
    target: Uuid,
) -> Result<(), ApiError> {
    let sql = format!(
        "SELECT count(*),count(*) FILTER (WHERE u.role IN ('owner','admin')),count(*) FILTER (WHERE u.id<>$3),count(*) FILTER (WHERE u.id<>$3 AND u.role IN ('owner','admin')) FROM channel_members cm JOIN ({}) u ON u.organization_id=cm.organization_id AND u.id=cm.member_id AND u.membership_revision=cm.membership_revision WHERE cm.organization_id=$1 AND cm.channel_id=$2",
        auth::members::ACTIVE_SCOPED_MEMBERS_SQL
    );
    let (_, managers, remaining, remaining_managers): (i64, i64, i64, i64) = sqlx::query_as(&sql)
        .bind(org)
        .bind(channel)
        .bind(target)
        .fetch_one(connection)
        .await?;
    if remaining == 0 {
        return Err(ApiError(StatusCode::CONFLICT, "last_channel_grant", None));
    }
    if managers > 0 && remaining_managers == 0 {
        return Err(ApiError(StatusCode::CONFLICT, "last_channel_manager", None));
    }
    Ok(())
}
