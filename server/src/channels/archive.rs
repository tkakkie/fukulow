use super::*;
use auth::DeferredOrganizationAuth;
use axum::{
    extract::{FromRequestParts, Path, rejection::PathRejection},
    http::request::Parts,
};

pub struct ChannelMetadataAuth(pub(crate) Option<Auth>);

impl FromRequestParts<AppState> for ChannelMetadataAuth {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let auth = DeferredOrganizationAuth::from_request_parts(parts, state).await;
        if matches!(&auth, Err(error) if error.0 == StatusCode::BAD_REQUEST) {
            // These routes require a Session check even when the path cannot be decoded.
            auth::AccountAuth::from_request_parts(parts, state).await?;
        }
        auth.map(|DeferredOrganizationAuth(auth)| Self(auth))
    }
}

#[derive(Deserialize, ToSchema)]
#[serde(untagged, deny_unknown_fields)]
pub enum UpdateChannelRequest {
    #[schema(max_properties = 1)]
    Rename {
        #[schema(min_length = 1, max_length = 128)]
        name: String,
    },
    #[schema(max_properties = 1)]
    Archive { archived: bool },
}

fn channel_not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "channel not found", None)
}

fn dm_channel_fixed() -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, "dm_channel_fixed", None)
}

pub(super) fn channel_archived() -> ApiError {
    ApiError(StatusCode::CONFLICT, "channel_archived", None)
}

/// Read one accessible ordinary Channel, including archived Channels.
#[utoipa::path(get, path = "/api/v1/orgs/{org}/channels/{id}",
    params(("org" = Uuid, Path), ("id" = Uuid, Path)),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Accessible ordinary Channel", body = Channel),
        (status = 400, description = "Invalid path or dm_channel_fixed for an accessible DM", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 404, description = "organization_unavailable or channel not found", body = ErrorBody),
        (status = 500, description = "Database failure", body = ErrorBody)))]
pub async fn get_channel(
    State(state): State<AppState>,
    ChannelMetadataAuth(auth): ChannelMetadataAuth,
    path: Result<Path<(Uuid, Uuid)>, PathRejection>,
) -> Result<Response, ApiError> {
    let Path((_, id)) = path.map_err(|_| ApiError::bad_request())?;
    let auth = auth.ok_or_else(ApiError::organization_unavailable)?;
    let org = auth.identity.organization.organization_id;
    let channel = crate::database::organization_read_only(
        &state.pool,
        org,
        async |tx: &mut sqlx::PgConnection| {
            let row = visible_channel_rows(tx, &auth, ChannelSelection::ById(id))
                .await?
                .pop()
                .ok_or_else(channel_not_found)?;
            if row.id.is_none() {
                return Err(channel_not_found());
            }
            row.ordinary(org).ok_or_else(dm_channel_fixed)
        },
    )
    .await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(channel)).into_response())
}

/// Supply exactly one of name or archived. An authorized no-op returns 204.
#[utoipa::path(patch, path = "/api/v1/orgs/{org}/channels/{id}",
    params(("org" = Uuid, Path), ("id" = Uuid, Path)),
    request_body = UpdateChannelRequest, security(("cookie" = []), ("bearer" = [])),
    responses((status = 204, description = "Channel updated or already in the requested state"),
        (status = 400, description = "Invalid path, input or name; dm_channel_fixed for an accessible DM", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 403, description = "forbidden: current Member may not change this Channel", body = ErrorBody),
        (status = 404, description = "organization_unavailable or channel not found", body = ErrorBody),
        (status = 409, description = "channel_archived or channel name already exists", body = ErrorBody),
        (status = 413, description = "Request body exceeds the size limit", body = ErrorBody),
        (status = 415, description = "Requires application/json", body = ErrorBody),
        (status = 500, description = "Database or worker failure", body = ErrorBody)))]
pub async fn update_channel(
    State(state): State<AppState>,
    ChannelMetadataAuth(auth): ChannelMetadataAuth,
    path: Result<Path<(Uuid, Uuid)>, PathRejection>,
    ApiJson(input): ApiJson<UpdateChannelRequest>,
) -> Result<Response, ApiError> {
    let Path((_, channel)) = path.map_err(|_| ApiError::bad_request())?;
    if let UpdateChannelRequest::Rename { name } = &input {
        validate_name(name)?;
    }
    let auth = auth.ok_or_else(ApiError::organization_unavailable)?;
    let organization = auth.identity.organization.organization_id;
    tokio::spawn(async move {
        let changed = crate::database::organization(
            &state.pool,
            organization,
            async |tx: &mut sqlx::PgConnection| update(tx, &auth, channel, input).await,
        )
        .await?;
        if changed {
            state.session_changes.channel_changed(
                state.pool,
                organization,
                auth::activity::ChannelChange::Metadata { channel },
            );
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

async fn update(
    tx: &mut sqlx::PgConnection,
    auth: &Auth,
    channel: Uuid,
    input: UpdateChannelRequest,
) -> Result<bool, ApiError> {
    let org = auth.identity.organization.organization_id;
    sqlx::query("SET LOCAL lock_timeout='5s'")
        .execute(&mut *tx)
        .await?;
    auth::members::lock_organization(tx, org).await?;
    let (actor, resource, archived) = match lock_channel_access(
        tx,
        org,
        (auth.identity.member.id, auth.membership_revision),
        channel,
        ChannelLock::NoKeyUpdate,
    )
    .await?
    {
        LockedAccess::OrganizationUnavailable => return Err(ApiError::organization_unavailable()),
        LockedAccess::ChannelUnavailable => return Err(channel_not_found()),
        LockedAccess::Visible {
            actor,
            resource,
            archived,
        } => (actor, resource, archived),
    };
    if matches!(resource, Resource::Dm { .. }) {
        return Err(dm_channel_fixed());
    }
    match input {
        UpdateChannelRequest::Rename { name } => {
            auth::authorization::require(actor, Action::RenameChannel, resource)?;
            if archived {
                return Err(channel_archived());
            }
            let result = sqlx::query(
                "UPDATE channels SET name=$3 WHERE organization_id=$1 AND id=$2 \
                 AND name COLLATE \"C\" IS DISTINCT FROM $3",
            )
            .bind(org)
            .bind(channel)
            .bind(name)
            .execute(tx)
            .await
            .map_err(name_write_error)?;
            Ok(result.rows_affected() != 0)
        }
        UpdateChannelRequest::Archive { archived: desired } => {
            auth::authorization::require(actor, Action::ArchiveChannel, resource)?;
            if archived == desired {
                return Ok(false);
            }
            sqlx::query(
                "UPDATE channels SET archived_at=CASE WHEN $3 THEN now() ELSE NULL END \
                 WHERE organization_id=$1 AND id=$2",
            )
            .bind(org)
            .bind(channel)
            .bind(desired)
            .execute(tx)
            .await?;
            Ok(true)
        }
    }
}
