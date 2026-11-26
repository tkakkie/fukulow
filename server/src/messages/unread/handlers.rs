use axum::{
    extract::{
        Path, Query, State,
        rejection::{PathRejection, QueryRejection},
    },
    http::StatusCode,
    response::Response,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::messages::{MessageError, no_store_json};
use crate::{
    AppState,
    auth::{ApiError, ApiJson, Auth, ErrorBody},
};

use super::{
    list::{self, ChannelList},
    mark::{self, ReadPosition},
};

#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ChannelListQuery {
    pub history_generation: Option<Uuid>,
    /// Return archived Channels when true. The default lists active Channels.
    pub archived: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MarkReadRequest {
    pub history_generation: Option<Uuid>,
    /// Monotonic max, clamped to the latest committed Channel seq. Sending never marks read.
    #[schema(minimum = 0)]
    pub read_seq: i64,
}

/// List visible Channels with the current Member's read positions and Unread counts.
///
/// Public Channels require a non-Guest Role or a current grant; private Channels require a current grant.
#[utoipa::path(get, path = "/api/v1/orgs/{org}/channels",
    params(("org" = Uuid, Path, description = "Organization id"), ChannelListQuery),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Visible Channels with current Member positions and Unread counts; refetch on reconnect", body = ChannelList),
        (status = 400, description = "Malformed Organization id or invalid query input", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 409, description = "history_generation_changed for a stale Organization epoch", body = crate::auth::ErrorBody),
        (status = 404, description = "Non-Member, unknown Organization or deactivated Member: organization_unavailable", body = ErrorBody),
        (status = 500, description = "Database failure while listing visible Channels and Unread", body = ErrorBody)))]
pub async fn list_channels(
    State(state): State<AppState>,
    auth: Auth,
    query: Result<Query<ChannelListQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let Query(query) =
        query.map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid input", None))?;
    let list = list::visible_channels(
        &state,
        &auth,
        query.archived.unwrap_or(false),
        query.history_generation,
    )
    .await?;
    Ok(no_store_json(list))
}

#[utoipa::path(put, path = "/api/v1/orgs/{org}/channels/{id}/read", request_body = MarkReadRequest,
    params(("org" = Uuid, Path), ("id" = Uuid, Path)),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Monotonic Channel position for Messages without Topic only", body = ReadPosition),
        (status = 400, description = "Invalid ids, negative read_seq or malformed JSON; Topic read in an accessible DM refuses dm_topics_not_allowed", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 409, description = "history_generation_changed for a stale Organization epoch", body = crate::auth::ErrorBody),
        (status = 404, description = "organization_unavailable or channel not found", body = ErrorBody),
        (status = 413, description = "Request body exceeds size limit", body = ErrorBody),
        (status = 415, description = "Requires application/json", body = ErrorBody),
        (status = 503, description = "Watermark admission unavailable; Retry-After gives retry seconds", body = ErrorBody,
            headers(("Retry-After" = inline(crate::auth::RetryAfterSeconds), description = "Retry delay in seconds"))),
        (status = 500, description = "Database failure or watermark timeout", body = ErrorBody)))]
pub async fn mark_channel_read(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid)>, PathRejection>,
    ApiJson(input): ApiJson<MarkReadRequest>,
) -> Result<Response, MessageError> {
    let Path((_, channel)) = path.map_err(|_| MessageError::InvalidInput)?;
    let position = mark::mark_read(
        &state,
        &auth,
        channel,
        None,
        input.history_generation,
        input.read_seq,
    )
    .await?;
    Ok(no_store_json(position))
}

#[utoipa::path(put, path = "/api/v1/orgs/{org}/channels/{id}/topics/{topic_id}/read", request_body = MarkReadRequest,
    params(("org" = Uuid, Path), ("id" = Uuid, Path), ("topic_id" = Uuid, Path)),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Monotonic position for this Topic only", body = ReadPosition),
        (status = 400, description = "Invalid ids, negative read_seq or malformed JSON", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 409, description = "history_generation_changed for a stale Organization epoch", body = crate::auth::ErrorBody),
        (status = 404, description = "organization_unavailable, channel not found or topic_not_found; unknown and foreign Topics are identical", body = ErrorBody),
        (status = 413, description = "Request body exceeds size limit", body = ErrorBody),
        (status = 415, description = "Requires application/json", body = ErrorBody),
        (status = 503, description = "Watermark admission unavailable; Retry-After gives retry seconds", body = ErrorBody,
            headers(("Retry-After" = inline(crate::auth::RetryAfterSeconds), description = "Retry delay in seconds"))),
        (status = 500, description = "Database failure or watermark timeout", body = ErrorBody)))]
pub async fn mark_topic_read(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid, Uuid)>, PathRejection>,
    ApiJson(input): ApiJson<MarkReadRequest>,
) -> Result<Response, MessageError> {
    let Path((_, channel, topic)) = path.map_err(|_| MessageError::InvalidInput)?;
    let position = mark::mark_read(
        &state,
        &auth,
        channel,
        Some(topic),
        input.history_generation,
        input.read_seq,
    )
    .await?;
    Ok(no_store_json(position))
}
