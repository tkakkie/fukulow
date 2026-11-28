use axum::{
    Json,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};

use super::{limiter, no_store_json};
use crate::auth::{ApiError, ApiErrorDetail, ErrorBody};

#[derive(Debug)]
pub enum MessageError {
    InvalidInput,
    DmTopicsNotAllowed,
    DmPeerDeactivated,
    DmPeerAccessLapsed,
    NotFound,
    TopicNotFound,
    ReplyTopicNotAllowed,
    ReplyParentNotFound,
    ReplyChainNotFound,
    OrganizationUnavailable,
    HistoryGenerationChanged,
    SnapshotExpired,
    MoveNotAllowed,
    ChannelArchived,
    VersionConflict,
    OperationConflict,
    ChainTooLarge,
    Conflict,
    AdmissionRejected,
    ProjectionAdmissionRejected,
    /// Over the per-Member send limit: seconds until the next token.
    Throttled(u64),
    /// A send-limiter tracking cap was reached.
    LimiterSaturated,
    Database(sqlx::Error),
}

impl MessageError {
    /// The same response for an identical request that waited on this one. Database
    /// details are not shared; the response is the same 500.
    pub(super) fn replay(&self) -> Self {
        match self {
            Self::InvalidInput => Self::InvalidInput,
            Self::DmTopicsNotAllowed => Self::DmTopicsNotAllowed,
            Self::DmPeerDeactivated => Self::DmPeerDeactivated,
            Self::DmPeerAccessLapsed => Self::DmPeerAccessLapsed,
            Self::NotFound => Self::NotFound,
            Self::TopicNotFound => Self::TopicNotFound,
            Self::ReplyTopicNotAllowed => Self::ReplyTopicNotAllowed,
            Self::ReplyParentNotFound => Self::ReplyParentNotFound,
            Self::ReplyChainNotFound => Self::ReplyChainNotFound,
            Self::OrganizationUnavailable => Self::OrganizationUnavailable,
            Self::HistoryGenerationChanged => Self::HistoryGenerationChanged,
            Self::SnapshotExpired => Self::SnapshotExpired,
            Self::MoveNotAllowed => Self::MoveNotAllowed,
            Self::ChannelArchived => Self::ChannelArchived,
            Self::VersionConflict => Self::VersionConflict,
            Self::OperationConflict => Self::OperationConflict,
            Self::ChainTooLarge => Self::ChainTooLarge,
            Self::Conflict => Self::Conflict,
            Self::AdmissionRejected => Self::AdmissionRejected,
            Self::ProjectionAdmissionRejected => Self::ProjectionAdmissionRejected,
            Self::Throttled(seconds) => Self::Throttled(*seconds),
            Self::LimiterSaturated => Self::LimiterSaturated,
            Self::Database(_) => Self::Database(sqlx::Error::Protocol(
                "identical in-flight send failed".into(),
            )),
        }
    }
}

impl From<limiter::Refusal> for MessageError {
    fn from(refusal: limiter::Refusal) -> Self {
        match refusal {
            limiter::Refusal::Throttled(seconds) => Self::Throttled(seconds),
            limiter::Refusal::Saturated => Self::LimiterSaturated,
        }
    }
}

impl From<sqlx::Error> for MessageError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl IntoResponse for MessageError {
    fn into_response(self) -> Response {
        let (status, error) = match self {
            Self::HistoryGenerationChanged => (StatusCode::CONFLICT, "history_generation_changed"),
            Self::SnapshotExpired => (StatusCode::CONFLICT, "snapshot_expired"),
            Self::MoveNotAllowed => (StatusCode::FORBIDDEN, "move_not_allowed"),
            Self::VersionConflict => (StatusCode::CONFLICT, "version_conflict"),
            Self::ChannelArchived => (StatusCode::CONFLICT, "channel_archived"),
            Self::OperationConflict => (StatusCode::CONFLICT, "operation_conflict"),
            Self::ChainTooLarge => (StatusCode::CONFLICT, "chain_too_large"),
            Self::InvalidInput => (StatusCode::BAD_REQUEST, "invalid input"),
            Self::DmTopicsNotAllowed => (StatusCode::BAD_REQUEST, "dm_topics_not_allowed"),
            Self::DmPeerDeactivated => return ApiError::dm_peer_deactivated().into_response(),
            Self::DmPeerAccessLapsed => return ApiError::dm_peer_access_lapsed().into_response(),
            Self::ReplyTopicNotAllowed => (StatusCode::BAD_REQUEST, "reply_topic_not_allowed"),
            Self::ReplyParentNotFound => (StatusCode::NOT_FOUND, "reply_parent_not_found"),
            Self::ReplyChainNotFound => (StatusCode::NOT_FOUND, "reply_chain_not_found"),
            Self::TopicNotFound => (StatusCode::NOT_FOUND, "topic_not_found"),
            Self::NotFound => return ApiError::channel_not_found().into_response(),
            Self::OrganizationUnavailable => {
                return ApiError::organization_unavailable().into_response();
            }
            Self::Conflict => (
                StatusCode::CONFLICT,
                "client message id reused with different body, channel, Topic or reply target",
            ),
            Self::Database(error) => return ApiError::from(error).into_response(),
            Self::Throttled(seconds) => {
                return retry_later(StatusCode::TOO_MANY_REQUESTS, seconds, "send_rate_limited");
            }
            Self::LimiterSaturated => {
                return retry_later(
                    StatusCode::SERVICE_UNAVAILABLE,
                    1,
                    "send limiter unavailable",
                );
            }
            rejection @ (Self::AdmissionRejected | Self::ProjectionAdmissionRejected) => {
                return retry_later(
                    StatusCode::SERVICE_UNAVAILABLE,
                    rand::random_range(1..=5_u64),
                    match rejection {
                        Self::ProjectionAdmissionRejected => "projection admission unavailable",
                        _ => "send admission unavailable",
                    },
                );
            }
        };
        (
            status,
            no_store_json(ErrorBody {
                error: error.into(),
            }),
        )
            .into_response()
    }
}

fn retry_later(status: StatusCode, seconds: u64, error: &str) -> Response {
    (
        status,
        [
            (header::CACHE_CONTROL, "no-store".to_owned()),
            (header::RETRY_AFTER, seconds.to_string()),
        ],
        Json(ErrorBody {
            error: error.into(),
        }),
    )
        .into_response()
}

pub(super) fn dm_error(error: ApiError) -> MessageError {
    match error.2 {
        Some(ApiErrorDetail::OrganizationUnavailable) => MessageError::OrganizationUnavailable,
        Some(ApiErrorDetail::ChannelNotFound) => MessageError::NotFound,
        Some(ApiErrorDetail::DmPeerDeactivated) => MessageError::DmPeerDeactivated,
        Some(ApiErrorDetail::DmPeerAccessLapsed) => MessageError::DmPeerAccessLapsed,
        _ => MessageError::Database(sqlx::Error::Protocol("DM authorization failed".into())),
    }
}
