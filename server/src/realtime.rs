use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{auth::ErrorBody, messages::Message};

/// Queue overflow: reconnect and subscribe from the last seq per channel; never drop silently.
pub const CLOSE_QUEUE_OVERFLOW: u16 = 4008;
/// Session expired or signed out: stop protected delivery and go to Sign in.
pub const CLOSE_SESSION_ENDED: u16 = 4001;

/// Client -> server control messages. Cursors are per channel and exclusive.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Subscribe {
        channel_id: Uuid,
        /// Replay committed messages with seq > after_seq; 0 starts at the beginning.
        #[schema(minimum = 0)]
        after_seq: i64,
    },
    Unsubscribe {
        channel_id: Uuid,
    },
}

/// Server -> client events. Clients dedupe messages by (channel_id, seq).
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    /// Live and replayed messages have exactly the same canonical shape.
    Message { message: Message },
    /// Sent after committed replay and queued live events have been handed off.
    Subscribed {
        channel_id: Uuid,
        /// Last sequence caught up through; 0 when the channel has no messages.
        #[schema(minimum = 0)]
        caught_up_seq: i64,
    },
    Error {
        code: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_id: Option<Uuid>,
    },
}

/// Upgrade to WebSocket. ClientMessage and ServerEvent are the message schema roots.
/// Authenticate with the session cookie or Authorization: Bearer, never a query token.
/// Cookie auth requires a matching allowed Origin (configured, same-origin by default);
/// reject a missing/foreign Origin with 403. Bearer clients need no Origin header.
///
/// On subscribe: first register the live subscription, queueing events per connection;
/// replay committed messages with seq > after_seq ascending in pages of up to the page
/// limit (default 50, max 200); flush queued live events with seq > last replayed;
/// then send subscribed with caught_up_seq. Clients dedupe by (channel_id, seq):
/// duplicates are harmless, gaps are forbidden. Publish only committed new messages.
/// Queue overflow closes with 4008 (never silently drops an event); reconnect and
/// re-subscribe from the last seq per channel. Expiry/sign-out closes with 4001;
/// stop protected delivery and go to Sign in.
/// Contract only: currently returns 501; no authentication, Origin check or upgrade.
#[utoipa::path(get, path = "/api/v1/ws",
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 101, description = "WebSocket upgrade; frames use ClientMessage / ServerEvent"),
        (status = 401, body = ErrorBody),
        (status = 403, description = "Cookie Origin missing or not allowed", body = ErrorBody),
        (status = 501, description = "Contract stub; not implemented")))]
pub async fn upgrade() -> StatusCode {
    StatusCode::NOT_IMPLEMENTED
}
