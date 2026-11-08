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
    pub name: String,
    pub visibility: ChannelVisibility,
}

/// Identity and organization come from the session, never from request fields.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateChannelRequest {
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
    responses((status = 200, body = ChannelList),
        (status = 401, body = ErrorBody)))]
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
         )) ORDER BY c.name, c.id",
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

/// Create a public or private channel in the caller's organization.
/// A private channel includes its creator as a member in the same transaction.
#[utoipa::path(post, path = "/api/v1/channels", request_body = CreateChannelRequest,
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 201, body = Channel),
        (status = 400, body = ErrorBody), (status = 401, body = ErrorBody),
        (status = 413, body = ErrorBody), (status = 415, body = ErrorBody)))]
pub async fn create_channel(
    State(state): State<AppState>,
    auth: Auth,
    ApiJson(input): ApiJson<CreateChannelRequest>,
) -> Result<Response, ApiError> {
    let organization_id = auth.identity.organization.organization_id;
    let mut tx = state.pool.begin().await?;
    let channel = sqlx::query_as::<_, Channel>(
        "INSERT INTO channels (organization_id, id, name, visibility) \
         VALUES ($1, $2, $3, $4) RETURNING id, name, visibility",
    )
    .bind(organization_id)
    .bind(Uuid::new_v4())
    .bind(input.name)
    .bind(input.visibility)
    .fetch_one(&mut *tx)
    .await?;
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

#[cfg(test)]
mod tests;

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
