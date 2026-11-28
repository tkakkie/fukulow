use axum::{
    extract::{Query, State, rejection::QueryRejection},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{ApiError, Auth, ErrorBody},
};

use super::{
    ChannelList, MessageError, TimelinePage, authors::AuthorIdentities, no_store_json, unread,
};

mod snapshot;

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct StartupQuery {
    /// Selected Channel. Defaults to the first visible active Channel in the list.
    pub channel_id: Option<Uuid>,
}

#[derive(Serialize, ToSchema)]
pub struct StartupTimeline {
    pub channel_id: Uuid,
    /// The initial subscription resumes from this page's generation and event watermark.
    pub page: TimelinePage,
    pub authors: AuthorIdentities,
}

#[derive(Serialize, ToSchema)]
pub struct StartupResponse {
    pub channel_list: ChannelList,
    /// Absent when there is no selected Channel.
    pub timeline: Option<StartupTimeline>,
}

enum StartupError {
    Channels(ApiError),
    Timeline(MessageError),
}

impl IntoResponse for StartupError {
    fn into_response(self) -> Response {
        match self {
            Self::Channels(error) => error.into_response(),
            Self::Timeline(error) => error.into_response(),
        }
    }
}

#[utoipa::path(get, path = "/api/v1/orgs/{org}/startup",
    params(("org" = Uuid, Path), StartupQuery),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Visible active Channels and the selected Channel's initial Timeline with its author identities", body = StartupResponse),
        (status = 400, description = "Invalid Organization or Channel id", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 404, description = "organization_unavailable or channel not found", body = ErrorBody),
        (status = 409, description = "history_generation_changed between Channel list and Timeline snapshots", body = ErrorBody),
        (status = 503, description = "Projection watermark admission unavailable", body = ErrorBody,
            headers(("Retry-After" = inline(crate::auth::RetryAfterSeconds), description = "Jittered retry delay in seconds (1 through 5)"))),
        (status = 500, description = "Database failure or commit barrier timeout", body = ErrorBody)))]
pub async fn get_startup(
    State(state): State<AppState>,
    auth: Auth,
    query: Result<Query<StartupQuery>, QueryRejection>,
) -> Result<Response, impl IntoResponse> {
    let Query(query) = query.map_err(|_| StartupError::Timeline(MessageError::InvalidInput))?;
    let channel_list = unread::visible_channels(&state, &auth, false, None)
        .await
        .map_err(StartupError::Channels)?;
    let timeline = snapshot::initial_timeline(&state, &auth, &channel_list, query.channel_id)
        .await
        .map_err(StartupError::Timeline)?;
    Ok::<_, StartupError>(no_store_json(StartupResponse {
        channel_list,
        timeline,
    }))
}
