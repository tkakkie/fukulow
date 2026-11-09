use axum::{
    Json,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{ApiError, ApiJson, Auth, ErrorBody},
};

#[derive(Debug, Serialize, Deserialize, ToSchema, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "text", rename_all = "snake_case")]
pub enum ChannelVisibility {
    Public,
    Private,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, sqlx::FromRow)]
pub struct Channel {
    pub id: Uuid,
    /// At most 128 Unicode scalar values.
    #[schema(max_length = 128)]
    pub name: String,
    pub visibility: ChannelVisibility,
}

/// Identity and organization come from the session, never from request fields.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateChannelRequest {
    /// At most 128 Unicode scalar values.
    /// Leading or trailing whitespace, as defined by Rust `str::trim()`, is rejected, not trimmed.
    /// Internal whitespace and empty names are allowed.
    #[schema(max_length = 128)]
    pub name: String,
    pub visibility: ChannelVisibility,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ChannelList {
    pub channels: Vec<Channel>,
}

/// List public channels of the caller's organization and private channels they belong to.
#[utoipa::path(get, path = "/api/v1/channels",
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Public Channels and private Channels the Member belongs to in their Organization", body = ChannelList),
        (status = 401, description = "Missing, invalid, ambiguous, expired, or revoked session credential", body = ErrorBody),
        (status = 500, description = "Database failure while resolving the session or listing visible Channels", body = ErrorBody)))]
pub async fn list_channels(
    State(state): State<AppState>,
    auth: Auth,
) -> Result<Response, ApiError> {
    let channels = sqlx::query_as::<_, Channel>(
        "SELECT c.id, c.name, c.visibility FROM channels c \
         WHERE c.organization_id = $1 AND (c.visibility = 'public' OR EXISTS (\
             SELECT 1 FROM channel_members cm \
             WHERE cm.organization_id = c.organization_id \
               AND cm.channel_id = c.id AND cm.member_id = $2\
         )) ORDER BY lower(c.name COLLATE \"C\"), c.id",
    )
    .bind(auth.identity.organization.organization_id)
    .bind(auth.identity.member.id)
    .fetch_all(&state.pool)
    .await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(ChannelList { channels }),
    )
        .into_response())
}

/// Create a public or private channel with an organization-unique name.
/// Names are compared with ASCII case folding; non-ASCII characters are unchanged.
/// A private channel includes its creator as a member in the same transaction.
#[utoipa::path(post, path = "/api/v1/channels", request_body = CreateChannelRequest,
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 201, description = "Created Channel; a private Channel includes its creator as a Member", body = Channel),
        (status = 400, description = "Invalid Channel JSON or fields, name over 128 Unicode scalar values, or surrounding whitespace", body = ErrorBody),
        (status = 401, description = "Missing, invalid, ambiguous, expired, or revoked session credential", body = ErrorBody),
        (status = 409, description = "Channel name already exists", body = ErrorBody),
        (status = 413, description = "Channel creation request body exceeds the size limit", body = ErrorBody),
        (status = 415, description = "Channel creation requires an application/json content type", body = ErrorBody),
        (status = 500, description = "Database failure while resolving the session or creating the Channel and its membership", body = ErrorBody)))]
pub async fn create_channel(
    State(state): State<AppState>,
    auth: Auth,
    ApiJson(input): ApiJson<CreateChannelRequest>,
) -> Result<Response, ApiError> {
    if input.name.chars().count() > 128 || input.name != input.name.trim() {
        return Ok((
            StatusCode::BAD_REQUEST,
            [(header::CACHE_CONTROL, "no-store")],
            Json(ErrorBody {
                error: "invalid input".into(),
            }),
        )
            .into_response());
    }
    let organization_id = auth.identity.organization.organization_id;
    let mut tx = state.pool.begin().await?;
    let channel = match sqlx::query_as::<_, Channel>(
        "INSERT INTO channels (organization_id, id, name, visibility) \
         VALUES ($1, $2, $3, $4) RETURNING id, name, visibility",
    )
    .bind(organization_id)
    .bind(Uuid::new_v4())
    .bind(input.name)
    .bind(input.visibility)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(channel) => channel,
        Err(error)
            if error.as_database_error().is_some_and(|error| {
                error.is_unique_violation()
                    && error.constraint() == Some("channels_organization_name_unique")
            }) =>
        {
            tx.rollback().await?;
            return Ok((
                StatusCode::CONFLICT,
                [(header::CACHE_CONTROL, "no-store")],
                Json(ErrorBody {
                    error: "channel name already exists".into(),
                }),
            )
                .into_response());
        }
        Err(error) => return Err(error.into()),
    };
    if matches!(channel.visibility, ChannelVisibility::Private) {
        sqlx::query(
            "INSERT INTO channel_members (organization_id, channel_id, member_id) \
             VALUES ($1, $2, $3)",
        )
        .bind(organization_id)
        .bind(channel.id)
        .bind(auth.identity.member.id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(channel),
    )
        .into_response())
}

// Keep channel visibility SQL here for message reads and sends.
pub(crate) async fn is_visible(
    pool: &sqlx::PgPool,
    organization_id: Uuid,
    member_id: Uuid,
    channel_id: Uuid,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM channels c \
         WHERE c.organization_id = $1 AND c.id = $3 \
           AND (c.visibility = 'public' OR EXISTS (\
               SELECT 1 FROM channel_members cm \
               WHERE cm.organization_id = c.organization_id \
                 AND cm.channel_id = c.id AND cm.member_id = $2)))",
    )
    .bind(organization_id)
    .bind(member_id)
    .bind(channel_id)
    .fetch_one(pool)
    .await
}

// Resolve all live recipients in one query, using the same rule as REST and replay.
pub(crate) async fn visible_members(
    pool: &sqlx::PgPool,
    organization_id: Uuid,
    channel_id: Uuid,
    members: &[Uuid],
) -> Result<Vec<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT member_id FROM UNNEST($3::uuid[]) AS candidate(member_id) \
         WHERE EXISTS (SELECT 1 FROM channels c WHERE c.organization_id = $1 AND c.id = $2 \
           AND (c.visibility = 'public' OR EXISTS (SELECT 1 FROM channel_members cm \
             WHERE cm.organization_id = c.organization_id AND cm.channel_id = c.id \
               AND cm.member_id = candidate.member_id)))",
    )
    .bind(organization_id)
    .bind(channel_id)
    .bind(members)
    .fetch_all(pool)
    .await
}

#[cfg(test)]
mod tests;
