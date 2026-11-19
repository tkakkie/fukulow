use axum::{
    Json,
    extract::{
        State, WebSocketUpgrade,
        ws::{CloseFrame, Message as Frame, WebSocket, rejection::WebSocketUpgradeRejection},
    },
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
#[cfg(test)]
use serde::Serialize;
use std::{collections::HashMap, time::Duration};
use tracing::Instrument;
#[cfg(test)]
use uuid::Uuid;

use crate::{
    AppState,
    auth::{Auth, ErrorBody},
    messages::LIVE_QUEUE_CAPACITY,
};

mod connection;
mod limits;
mod origin;
pub use limits::{Budget, SocketGate, SocketLimits};
pub use origin::AllowedOrigins;

pub use fukulow_api::{
    CLOSE_ORGANIZATION_UNAVAILABLE, CLOSE_QUEUE_OVERFLOW, CLOSE_RATE_LIMITED, CLOSE_SESSION_ENDED,
    ClientMessage, ServerEvent,
};

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
/// Every text or binary frame (subscribe, unsubscribe, invalid) is charged to a
/// per-connection and a per-Account budget before any database access; over
/// budget closes with 4029: reconnect with backoff. A subscribe for a Channel
/// already subscribed on this connection is ignored (no reply), whatever its after_seq.
#[utoipa::path(get, path = "/api/v1/orgs/{org}/ws",
    params(("org" = Uuid, Path, description = "Organization id")),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 101, description = "WebSocket upgrade; frames use ClientMessage / ServerEvent"),
        (status = 400, description = "Malformed Organization id, or invalid WebSocket upgrade after Origin validation and successful authentication", body = ErrorBody),
        (status = 401, description = "Missing, invalid, expired, or revoked Account Session credential before WebSocket upgrade", body = ErrorBody),
        (status = 403, description = "Cookie Origin missing or not allowed, checked before authentication and Organization resolution: origin_not_allowed", body = ErrorBody),
        (status = 404, description = "Non-Member, unknown Organization or deactivated Member: organization_unavailable", body = ErrorBody),
        (status = 500, description = "Database failure while resolving the session before WebSocket upgrade", body = ErrorBody),
        (status = 503, description = "socket_limit: the Account's or the server's open-socket cap is reached, or the Account's control-frame budget is empty (Retry-After 1 through 5, jittered); retry with the normal reconnect backoff", body = ErrorBody,
            headers(("Retry-After" = inline(crate::auth::RetryAfterSeconds), description = "Retry delay in seconds, at least 1")))))]
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
    // Dropped with the upgrade callback if the handshake never completes.
    let Some(permit) = state.socket_gate.admit(auth.account_id) else {
        crate::observability::admission(crate::observability::Admission::Socket);
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [
                (header::CACHE_CONTROL, "no-store".to_owned()),
                (
                    header::RETRY_AFTER,
                    rand::random_range(1..=5_u64).to_string(),
                ),
            ],
            Json(ErrorBody {
                error: "socket_limit".into(),
            }),
        )
            .into_response();
    };
    let socket_work = state.shutdown.sockets.enter();
    let span = tracing::Span::current();
    ws.max_message_size(16 * 1024)
        .max_frame_size(16 * 1024)
        .read_buffer_size(state.socket_gate.limits().read_buffer)
        .on_upgrade(move |socket| {
            connected(socket, state, auth, permit, socket_work).instrument(span)
        })
}

async fn connected(
    socket: WebSocket,
    state: AppState,
    auth: Auth,
    permit: limits::Permit,
    work: crate::shutdown::Guard,
) {
    let lifecycle = connection::Lifecycle::default();
    connected_with_lifecycle(socket, state, auth, permit, lifecycle, work).await;
}

async fn connected_with_lifecycle(
    mut socket: WebSocket,
    state: AppState,
    auth: Auth,
    permit: limits::Permit,
    lifecycle: connection::Lifecycle,
    _work: crate::shutdown::Guard,
) {
    let _observation = crate::observability::Socket::opened();
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
        Err(error) => {
            crate::observability::database_failure(&error);
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
        access: HashMap::new(),
        permit,
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
    } else {
        crate::observability::socket_closed(None);
    }
}

async fn close(socket: &mut WebSocket, code: u16) {
    crate::observability::socket_closed(Some(code));
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

impl From<crate::channels::activity::Notice> for ServerEvent {
    fn from(notice: crate::channels::activity::Notice) -> Self {
        use crate::channels::activity::Notice;
        match notice {
            Notice::ActivityReady => Self::ActivityReady,
            Notice::ActivityReset => Self::ActivityReset,
            Notice::ChannelActivity { channel_id, seq } => {
                Self::ChannelActivity { channel_id, seq }
            }
            Notice::ReadPositionChanged {
                channel_id,
                topic_id,
                read_seq,
            } => Self::ReadPositionChanged {
                channel_id,
                topic_id,
                read_seq,
            },
            Notice::ChannelAccessGained { channel_id } => Self::ChannelAccessGained { channel_id },
            Notice::ChannelAccessRevoked { channel_id } => {
                Self::ChannelAccessRevoked { channel_id }
            }
            Notice::ChannelListChanged => Self::ChannelListChanged,
            Notice::DmListChanged => Self::DmListChanged,
            Notice::SectionsChanged { generation } => Self::SectionsChanged {
                generation: generation.to_string(),
            },
            Notice::ChannelMembersChanged { channel_id } => {
                Self::ChannelMembersChanged { channel_id }
            }
            Notice::MembersChanged => Self::MembersChanged,
        }
    }
}
