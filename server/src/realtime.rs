use axum::{
    Json,
    extract::{
        State, WebSocketUpgrade,
        ws::{CloseFrame, Message as Frame, WebSocket, rejection::WebSocketUpgradeRejection},
    },
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, time::Duration};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{Auth, ErrorBody},
    messages::{LIVE_QUEUE_CAPACITY, Message},
};

mod connection;
mod origin;
pub use origin::AllowedOrigins;

/// Queue overflow: reconnect and subscribe from the last seq per channel; never drop silently.
pub const CLOSE_QUEUE_OVERFLOW: u16 = 4008;
/// Session expired or signed out: stop protected delivery and go to Sign in.
pub const CLOSE_SESSION_ENDED: u16 = 4001;
/// Membership ended for this Organization only: terminal unavailable, no reconnect.
pub const CLOSE_ORGANIZATION_UNAVAILABLE: u16 = 4003;

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
/// replay committed messages with seq > after_seq ascending in pages of up to 50
/// messages; flush queued live events with seq > last replayed;
/// then send subscribed with caught_up_seq. Clients dedupe by (channel_id, seq):
/// duplicates are harmless, gaps are forbidden. Publish only committed new messages.
/// Queue overflow closes with 4008 (never silently drops an event); reconnect and
/// re-subscribe from the last seq per channel. Expiry/sign-out closes with 4001;
/// stop protected delivery and go to Sign in. Membership loss closes only this
/// Organization with 4003: terminal unavailable, never reconnect/resubscribe/retry sends.
/// A rejected handshake has no close code: check GET /api/v1/orgs/{org}/me.
#[utoipa::path(get, path = "/api/v1/orgs/{org}/ws",
    params(("org" = Uuid, Path, description = "Organization id")),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 101, description = "WebSocket upgrade; frames use ClientMessage / ServerEvent"),
        (status = 400, description = "Malformed Organization id, or invalid WebSocket upgrade after Origin validation and successful authentication", body = ErrorBody),
        (status = 401, description = "Missing, invalid, expired, or revoked Account Session credential before WebSocket upgrade", body = ErrorBody),
        (status = 403, description = "Cookie Origin missing or not allowed, checked before authentication and Organization resolution: origin_not_allowed", body = ErrorBody),
        (status = 404, description = "Non-Member, unknown Organization or deactivated Member: organization_unavailable", body = ErrorBody),
        (status = 500, description = "Database failure while resolving the session before WebSocket upgrade", body = ErrorBody)))]
pub async fn upgrade(
    State(state): State<AppState>,
    _origin: origin::CheckedOrigin,
    auth: Auth,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let ws = match ws {
        Ok(ws) => ws,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                [(header::CACHE_CONTROL, "no-store")],
                Json(ErrorBody {
                    error: "invalid websocket upgrade".into(),
                }),
            )
                .into_response();
        }
    };
    let socket_work = state.shutdown.sockets.enter();
    ws.max_message_size(16 * 1024)
        .max_frame_size(16 * 1024)
        .on_upgrade(move |socket| connected(socket, state, auth, socket_work))
}

async fn connected(socket: WebSocket, state: AppState, auth: Auth, work: crate::shutdown::Guard) {
    connected_with_lifecycle(socket, state, auth, connection::Lifecycle::default(), work).await;
}

async fn connected_with_lifecycle(
    mut socket: WebSocket,
    state: AppState,
    auth: Auth,
    lifecycle: connection::Lifecycle,
    _work: crate::shutdown::Guard,
) {
    let session = tokio::select! {
        biased;
        _ = state.shutdown.cancelled() => { close(&mut socket, 1001).await; return; }
        session = auth.watch_session(&state) => session,
    };
    let mut session = match session {
        Ok(Some(session)) => session,
        Ok(None) => {
            close(&mut socket, CLOSE_SESSION_ENDED).await;
            return;
        }
        Err(_) => {
            close(&mut socket, 1011).await;
            return;
        }
    };
    // Session admission checks worker health after SQL as well as at registration.
    // A stopped fallback worker must never admit an unmonitored subscription.
    let queue = state.message_delivery.queue(
        auth.identity.organization.organization_id,
        (auth.identity.member.id, auth.membership_revision),
        LIVE_QUEUE_CAPACITY,
    );
    let mut overflow = queue.overflow.clone();
    // Frame/live/heartbeat wakes must only poll a oneshot, not every epoch wait.
    let mut notification_failed = queue.notification_failed.clone().spawn();
    let mut connection = connection::Connection {
        state: &state,
        auth: &auth,
        queue,
        cursors: HashMap::new(),
    };
    let code = tokio::select! {
        biased;
        _ = state.shutdown.cancelled() => Some(1001),
        result = session.ended() => Some(result.unwrap_or(1011)),
        _ = overflow.wait_for(|full| *full) => Some(CLOSE_QUEUE_OVERFLOW),
        _ = notification_failed.failed() => Some(1011),
        result = connection.run(&mut socket, lifecycle) => result.err(),
    };
    if let Some(code) = code {
        close(&mut socket, code).await;
    }
}

async fn close(socket: &mut WebSocket, code: u16) {
    let _ = tokio::time::timeout(
        Duration::from_secs(1),
        socket.send(Frame::Close(Some(CloseFrame {
            code,
            reason: "".into(),
        }))),
    )
    .await;
}

#[cfg(test)]
mod tests;
