use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::auth::ErrorBody;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct Message {
    pub id: Uuid,
    pub channel_id: Uuid,
    /// Per-channel sequence, starting at 1.
    #[schema(minimum = 1)]
    pub seq: i64,
    pub client_message_id: Uuid,
    /// Member id of the sender.
    pub sender: Uuid,
    pub body: String,
    #[schema(format = DateTime)]
    pub created_at: String,
    /// Always null in this contract; topics are deferred.
    #[schema(schema_with = null_schema)]
    pub topic_id: (),
}

// utoipa represents Rust unit as an unconstrained schema with default null.
// The wire contract requires null, including in generated TypeScript.
fn null_schema() -> utoipa::openapi::schema::Object {
    utoipa::openapi::schema::ObjectBuilder::new()
        .schema_type(utoipa::openapi::schema::Type::Null)
        .build()
}

/// Idempotency key: (organization, sender, client_message_id), derived from the session.
/// A retry with the same body and channel returns the same canonical message and sequence;
/// reusing the key with a different body or channel returns 409.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SendMessageRequest {
    pub client_message_id: Uuid,
    pub body: String,
}

/// Use after_seq XOR before_seq, or neither for the latest page. Cursors are exclusive.
#[derive(Debug, Serialize, Deserialize, IntoParams, ToSchema)]
#[into_params(parameter_in = Query)]
pub struct ListMessagesQuery {
    /// Return seq > after_seq; 0 starts at the beginning. Cannot combine with before_seq.
    #[param(minimum = 0)]
    #[schema(minimum = 0)]
    pub after_seq: Option<i64>,
    /// Return seq < before_seq. Cannot combine with after_seq.
    #[param(minimum = 1)]
    #[schema(minimum = 1)]
    pub before_seq: Option<i64>,
    /// Page size, default 50, maximum 200.
    #[param(minimum = 1, maximum = 200, default = 50)]
    #[schema(minimum = 1, maximum = 200, default = 50)]
    pub limit: Option<u16>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct MessagePage {
    /// Always ascending seq (newest last), including latest and before_seq pages.
    pub messages: Vec<Message>,
    /// More messages exist in the queried direction (older for latest/before_seq,
    /// newer for after_seq). Continue after_seq with the last seq or before_seq
    /// with the first seq; continue the latest page toward older messages with before_seq.
    pub has_more: bool,
}

/// List visible channel messages using exclusive per-channel sequence cursors.
/// after_seq and before_seq are mutually exclusive; neither selects the latest page.
/// Pages are always ascending seq. Continue after_seq with the last seq, or before_seq
/// (including older history from the latest page) with the first seq. has_more refers
/// to that direction. limit defaults to 50 and is bounded to 1..=200; invalid queries
/// return 400. Identity and organization come only from the authenticated session.
/// Contract only: currently returns 501 without parsing input or accessing the database.
#[utoipa::path(get, path = "/api/v1/channels/{id}/messages",
    params(("id" = Uuid, Path, description = "Channel id"), ListMessagesQuery),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, body = MessagePage),
        (status = 400, body = ErrorBody), (status = 401, body = ErrorBody),
        (status = 403, description = "Channel access denied", body = ErrorBody),
        (status = 404, description = "Channel not found", body = ErrorBody),
        (status = 501, description = "Contract stub; not implemented")))]
pub async fn list_messages() -> StatusCode {
    StatusCode::NOT_IMPLEMENTED
}

/// Send a message to a visible channel; topic_id is always null.
/// The session supplies organization and sender. A successful retry returns the same
/// canonical message with 201, allocating no new sequence and publishing no new event.
/// A reused client_message_id with different body or channel returns 409.
/// Contract only: currently returns 501 without parsing input or accessing the database.
#[utoipa::path(post, path = "/api/v1/channels/{id}/messages", request_body = SendMessageRequest,
    params(("id" = Uuid, Path, description = "Channel id")),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 201, body = Message),
        (status = 400, body = ErrorBody), (status = 401, body = ErrorBody),
        (status = 403, description = "Channel access denied", body = ErrorBody),
        (status = 404, description = "Channel not found", body = ErrorBody),
        (status = 409, description = "Client message id reused with different body or channel", body = ErrorBody),
        (status = 413, body = ErrorBody), (status = 415, body = ErrorBody),
        (status = 501, description = "Contract stub; not implemented")))]
pub async fn send_message() -> StatusCode {
    StatusCode::NOT_IMPLEMENTED
}
