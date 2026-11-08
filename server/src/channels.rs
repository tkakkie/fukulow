use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::auth::ErrorBody;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ChannelVisibility {
    Public,
    Private,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
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
/// Contract only: currently returns 501 without authentication or database access.
#[utoipa::path(get, path = "/api/v1/channels",
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, body = ChannelList),
        (status = 401, body = ErrorBody),
        (status = 501, description = "Contract stub; not implemented")))]
pub async fn list_channels() -> StatusCode {
    StatusCode::NOT_IMPLEMENTED
}

/// Create a public or private channel in the caller's organization.
/// A private channel includes its creator as a member in the same transaction.
/// Contract only: currently returns 501 without parsing input or accessing the database.
#[utoipa::path(post, path = "/api/v1/channels", request_body = CreateChannelRequest,
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 201, body = Channel),
        (status = 400, body = ErrorBody), (status = 401, body = ErrorBody),
        (status = 413, body = ErrorBody), (status = 415, body = ErrorBody),
        (status = 501, description = "Contract stub; not implemented")))]
pub async fn create_channel() -> StatusCode {
    StatusCode::NOT_IMPLEMENTED
}
