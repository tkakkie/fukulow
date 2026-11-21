use axum::{
    Json,
    extract::{
        Path, Query, State,
        rejection::{PathRejection, QueryRejection},
    },
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{ApiError, ApiJson, Auth, DeferredOrganizationAuth, ErrorBody},
    channels,
};

mod admission;
pub mod authors;
mod commit;
mod delivery;
pub mod dms;
mod failure;
pub(crate) mod history;
mod limiter;
pub(crate) mod log;
pub(crate) use log::ChannelEvent;
pub use log::list_channel_events;
mod mentions;
pub(crate) mod move_topic;
pub use move_topic::move_chain;
pub mod receipts;
pub use fukulow_api::{ListMessagesQuery, Mention, Message, MessagePage, SendMessageRequest};
pub use limiter::SendLimit;
pub(crate) mod replies;
pub use replies::counts::{ReplyCount, ReplyCountPage, ReplyCountRequest, reply_counts};
pub use replies::{ReplyChainPage, ReplyChainQuery, reply_chain};
pub mod search;
pub(crate) mod topics;
pub(crate) mod unread;
#[cfg(test)]
pub(crate) use commit::{ambiguous_commit, pause_commit};
pub use delivery::Delivery;
pub(crate) use delivery::LIVE_QUEUE_CAPACITY;
#[cfg(test)]
pub(crate) use delivery::{
    MAX_IN_FLIGHT_NOTIFICATIONS, MAX_ORGANIZATION_NOTIFICATIONS, NOTIFICATION_TIMEOUT,
    PublicationGate, pause_publication,
};
pub use topics::{
    ListProjectionQuery, TimelineItem, TimelinePage, TopicPage, TopicSummary, TopicSummaryResponse,
    list_timeline, list_topics, topic_history, topic_summary,
};
pub use unread::{
    ChannelList, MarkReadRequest, ReadPosition, UnreadChannel, list_channels, mark_channel_read,
    mark_topic_read,
};

fn message_from_row(row: &sqlx::postgres::PgRow) -> Result<Message, sqlx::Error> {
    use sqlx::Row;
    let deleted: bool = row.try_get("deleted")?;
    let (body, mentions) = if deleted {
        (None, None)
    } else {
        let mentions: String = row.try_get("mentions")?;
        let mentions =
            serde_json::from_str(&mentions).map_err(|error| sqlx::Error::ColumnDecode {
                index: "mentions".into(),
                source: Box::new(error),
            })?;
        (Some(row.try_get("body")?), Some(mentions))
    };
    Ok(Message {
        history_generation: row.try_get("history_generation")?,
        id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        created_seq: row.try_get("seq")?,
        version: row.try_get("version")?,
        deleted,
        client_message_id: row.try_get("client_message_id")?,
        sender: row.try_get("sender")?,
        body,
        created_at: row.try_get("created_at")?,
        topic_id: row.try_get("topic_id")?,
        reply_to: row.try_get("reply_to")?,
        reply_root_id: row.try_get("reply_root_id")?,
        mentions,
    })
}

/// List visible channel messages using exclusive per-channel sequence cursors.
/// after_seq and before_seq are mutually exclusive; neither selects the latest page.
/// Pages are always ascending seq. Continue after_seq with the last seq, or before_seq
/// (including older history from the latest page) with the first seq. has_more refers
/// to that direction. limit defaults to 50 and is bounded to 1..=200; invalid queries
/// return 400. Identity and organization come only from the authenticated session.
#[utoipa::path(get, path = "/api/v1/orgs/{org}/channels/{id}/messages",
    params(("org" = Uuid, Path, description = "Organization id"), ("id" = Uuid, Path, description = "Channel id"), ListMessagesQuery),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Page of Channel Messages in ascending sequence order with directional has_more", body = MessagePage),
        (status = 400, description = "Malformed Organization id, invalid Channel id, sequence cursors, or page limit; after_seq and before_seq cannot be combined", body = ErrorBody),
        (status = 401, description = "Missing, invalid, expired, or revoked Account Session credential", body = ErrorBody),
        (status = 409, description = "history_generation_changed for a stale Organization epoch; snapshot_expired for a fixed watermark below the Channel mutation floor; no partial page", body = crate::auth::ErrorBody),
        (status = 404, description = "organization_unavailable for an unavailable Organization; otherwise Channel does not exist or is private and the caller is not a member; the response does not reveal whether the Channel exists", body = ErrorBody),
        (status = 503, description = "Committed watermark admission unavailable", body = ErrorBody, headers(("Retry-After" = u64, description = "Retry seconds"))),
        (status = 500, description = "Database failure while resolving the session, checking Channel visibility, or listing Messages", body = ErrorBody)))]
pub async fn list_messages(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid)>, PathRejection>,
    query: Result<Query<ListMessagesQuery>, QueryRejection>,
) -> Result<Response, MessageError> {
    let Path((_, channel_id)) = path.map_err(|_| MessageError::InvalidInput)?;
    let Query(query) = query.map_err(|_| MessageError::InvalidInput)?;
    let limit = query.validate()?;
    let organization_id = auth.identity.organization.organization_id;
    require_visible_scoped(
        &state.pool,
        organization_id,
        (auth.identity.member.id, auth.membership_revision),
        channel_id,
    )
    .await?;
    topics::watermark(&state, organization_id, channel_id).await?;
    crate::database::organization_read_only(&state.pool, organization_id, async |tx: &mut sqlx::PgConnection| {
        match channels::is_visible(
            &mut *tx,
            organization_id,
            (auth.identity.member.id, auth.membership_revision),
            channel_id,
        )
        .await?
        {
            Some(true) => {}
            Some(false) => return Err(MessageError::NotFound),
            None => return Err(MessageError::OrganizationUnavailable),
        }
        #[cfg(test)]
        tests::membership::pause_history(channel_id).await;
        let (history_generation, w) = history::page(tx, organization_id, channel_id, query.history_generation, query.as_of_seq).await?;
        let ascending = query.after_seq.is_some();
        let sql = if ascending {
            "SELECT id, channel_id, seq, version, deleted, client_message_id, sender, body, topic_id, reply_to_id AS reply_to, reply_root_id, \
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at \
             FROM messages WHERE organization_id = $1 AND channel_id = $2 AND seq > $3 AND seq <= $5 \
             ORDER BY seq ASC LIMIT $4"
        } else {
            "SELECT id, channel_id, seq, version, deleted, client_message_id, sender, body, topic_id, reply_to_id AS reply_to, reply_root_id, \
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at \
             FROM messages WHERE organization_id = $1 AND channel_id = $2 \
               AND seq <= $3 AND seq <= $5 ORDER BY seq DESC LIMIT $4"
        };
        let cursor = if ascending {
            query.after_seq.unwrap_or(0)
        } else {
            // Convert exclusive before to an inclusive upper bound; validation guarantees >= 1.
            query.before_seq.map(|seq| seq - 1).unwrap_or(i64::MAX)
        };
        let sql = mentions::page_sql(sql, if ascending { "p.seq ASC" } else { "p.seq DESC" });
        let mut messages = sqlx::query(&sql)
            .bind(organization_id)
            .bind(channel_id)
            .bind(cursor)
            .bind(i64::from(limit) + 1)
            .bind(w)
            .try_map(|row| message_from_row(&row))
            .fetch_all(&mut *tx)
            .await?;
        let has_more = messages.len() > usize::from(limit);
        messages.truncate(usize::from(limit));
        if !ascending {
            messages.reverse();
        }
        Ok((
            [(header::CACHE_CONTROL, "no-store")],
            Json(MessagePage { history_generation, as_of_seq: w, messages, has_more }),
        )
            .into_response())
    })
    .await
}

/// Send a Message, optionally joining/creating a Topic by name in the same transaction.
/// For all sends, Account Session authentication precedes input validation (400/413/415),
/// which precedes organization_unavailable (404) and Channel authorization, then the
/// per-Member send limit (429), then admission (503).
/// The session supplies organization and sender. A successful retry returns the same
/// canonical message with 201, allocating no new sequence and publishing no new event.
/// A reused client_message_id with different body, Channel, normalized Topic name or reply target returns 409.
#[utoipa::path(post, path = "/api/v1/orgs/{org}/channels/{id}/messages", request_body = SendMessageRequest,
    params(("org" = Uuid, Path, description = "Organization id"), ("id" = Uuid, Path, description = "Channel id")),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 201, description = "Confirmed Message; an idempotent retry returns the same Message and sequence", body = Message),
        (status = 400, description = "Malformed Organization id, Channel id or Message JSON; body must be 1..=4000 scalars, nonblank and NUL-free; topic_name must be 1..=60 scalars, NUL-free and have no surrounding str::trim whitespace; topic_id is forbidden; reply_to with topic_name gives reply_topic_not_allowed; accessible DMs reject non-null Topic intent with dm_topics_not_allowed", body = ErrorBody),
        (status = 401, description = "Missing, invalid, expired, or revoked Account Session credential", body = ErrorBody),
        (status = 404, description = "organization_unavailable for an unavailable Organization; otherwise Channel does not exist or is private and the caller is not a member; reply_parent_not_found for an unknown, uncommitted or foreign Organization/Channel parent", body = ErrorBody),
        (status = 409, description = "history_generation_changed; Client message id reused with different body, Channel, normalized Topic name or reply target; channel_archived; new DM send: dm_peer_deactivated or dm_peer_access_lapsed", body = ErrorBody),
        (status = 413, description = "Message send request body exceeds the size limit", body = ErrorBody),
        (status = 415, description = "Sending a Message requires an application/json content type", body = ErrorBody),
        (status = 429, description = "send_rate_limited: the per-(Organization, Member) send limit (burst 10, 1 per second) is exhausted; checked after Channel authorization and before admission; nothing was charged, queued or persisted; retry after the delay with the same request and client_message_id", body = ErrorBody,
            headers(("Retry-After" = inline(crate::auth::RetryAfterSeconds), description = "Whole seconds until the next token; at least 1"))),
        (status = 500, description = "Database or worker failure while resolving the session, checking Channel visibility, or persisting the Message, including unknown COMMIT outcome or the 10 second database-work deadline; retry with the same client_message_id", body = ErrorBody),
        (status = 503, description = "Send admission queue is full or the 30 second admission wait expired (Retry-After 1 through 5, jittered), or a send-limiter tracking cap is full (Retry-After 1, nothing charged); persistence has not started; retry with the same client_message_id", body = ErrorBody,
            headers(("Retry-After" = inline(crate::auth::RetryAfterSeconds), description = "Retry delay in seconds, at least 1")))))]
pub async fn send_message(
    State(state): State<AppState>,
    DeferredOrganizationAuth(auth): DeferredOrganizationAuth,
    path: Result<Path<(Uuid, Uuid)>, PathRejection>,
    ApiJson(input): ApiJson<SendMessageRequest>,
) -> Result<Response, MessageError> {
    let Path((_, channel_id)) = path.map_err(|_| MessageError::InvalidInput)?;
    input.validate()?;
    let auth = auth.ok_or(MessageError::OrganizationUnavailable)?;
    let organization_id = auth.identity.organization.organization_id;
    let sender = (auth.identity.member.id, auth.membership_revision);
    require_visible_scoped(&state.pool, organization_id, sender, channel_id).await?;
    let limiter = &state.message_delivery.send_limiter;
    let key = (organization_id, sender.0, input.client_message_id);
    let intent = send_intent(channel_id, &input);
    // One execution per key at a time; waiters take no charge or slot. Identical
    // requests settle with that execution; another intent never inherits its failure (S6).
    let mut lead = loop {
        let (mut settled, identical) = match limiter.begin(key, intent) {
            Ok(limiter::Begin::Leader(lead)) => break lead,
            Ok(limiter::Begin::Wait(settled, identical)) => (settled, identical),
            Err(limiter::Refusal::Saturated) => {
                // A committed retry still answers canonically at the tracking cap (S5).
                return match committed(&state.pool, organization_id, sender, channel_id, &input)
                    .await?
                {
                    Some(message) => Ok(created(message)),
                    None => Err(MessageError::LimiterSaturated),
                };
            }
            Err(refusal) => return Err(refusal.into()),
        };
        let _ = settled.changed().await;
        let outcome = settled.borrow().clone();
        if let limiter::Settled::Refused(refusal) = &outcome
            && identical
        {
            if let Some(message) =
                committed(&state.pool, organization_id, sender, channel_id, &input).await?
            {
                return Ok(created(message));
            }
            return Err(refusal.replay());
        }
        if let limiter::Settled::Executed(failure) = outcome {
            if let Some(message) =
                committed(&state.pool, organization_id, sender, channel_id, &input).await?
            {
                return Ok(created(message));
            }
            if let Some(failure) = failure.filter(|_| identical) {
                return Err(failure.replay());
            }
        }
    };
    // A committed retry answers before the limiter and admission (S5).
    if let Some(message) =
        committed(&state.pool, organization_id, sender, channel_id, &input).await?
    {
        return Ok(created(message));
    }
    if input.topic_name.is_some() {
        reject_dm_topics_scoped(&state, &auth, channel_id).await?;
    }
    lead.charge()?;
    #[cfg(test)]
    limiter::charged(input.client_message_id).await;
    let admission = state.message_delivery.admission(&state.pool);
    let waiter = match admission.reserve_send(organization_id, channel_id) {
        Ok(waiter) => waiter,
        Err(refusal) => {
            // Identical waiters share this refusal rather than each paying again.
            lead.refuse(refusal.replay());
            return Err(refusal);
        }
    };
    // Finish persistence even if the HTTP caller disconnects; notification is detached.
    let work = state.message_delivery.work.enter();
    let message = tokio::spawn(async move {
        let _work = work;
        lead.executing();
        let result = persist(
            &state.pool,
            &state.message_delivery,
            organization_id,
            sender,
            channel_id,
            input,
            waiter,
        )
        .await;
        // Only a database failure other than a definite rollback may have committed.
        let failure = result.as_ref().err();
        let unknown = matches!(failure, Some(MessageError::Database(error)) if !commit::definitely_rolled_back(error));
        lead.settle(unknown, failure.map(MessageError::replay));
        result
    })
    .await
    .map_err(|_| MessageError::Database(sqlx::Error::WorkerCrashed))??;
    Ok(created(message))
}

/// Digest of what a send asks for, before normalization: requests that differ only
/// in Topic-name spelling are treated as different and each executes on its own.
fn send_intent(channel_id: Uuid, input: &SendMessageRequest) -> limiter::Intent {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    (channel_id, &input.body, &input.topic_name, input.reply_to).hash(&mut hasher);
    hasher.finish()
}

fn created(message: Message) -> Response {
    (
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(message),
    )
        .into_response()
}

/// The canonical Message for a committed `client_message_id`, or 409 for changed intent.
/// Access is rechecked first: a retry after access loss is denied, never answered.
/// Intent is compared with the receipt fixed at creation, never with current state,
/// and the answer is the Message's current state.
async fn committed(
    pool: &sqlx::PgPool,
    organization_id: Uuid,
    sender: (Uuid, i64),
    channel_id: Uuid,
    input: &SendMessageRequest,
) -> Result<Option<Message>, MessageError> {
    crate::database::organization_read_only(
        pool,
        organization_id,
        async |tx: &mut sqlx::PgConnection| {
            let archived = channels::visible_archive_state(tx, organization_id, sender, channel_id)
                .await?
                .ok_or(MessageError::OrganizationUnavailable)?
                .ok_or(MessageError::NotFound)?;
            if input.history_generation.is_some() {
                history::validate(
                    tx,
                    organization_id,
                    channel_id,
                    input.history_generation,
                    None,
                )
                .await?;
            }
            // The receipt query supplies the generation for a canonical retry.
            match receipt(&mut *tx, organization_id, sender.0, channel_id, input).await? {
                Some((message, true)) => Ok(Some(message)),
                Some((_, false)) => Err(MessageError::Conflict),
                None if archived => Err(MessageError::ChannelArchived),
                None => Ok(None),
            }
        },
    )
    .await
}

trait ValidateSendMessage {
    fn validate(&self) -> Result<(), MessageError>;
}

impl ValidateSendMessage for SendMessageRequest {
    fn validate(&self) -> Result<(), MessageError> {
        if self.reply_to.is_some() && self.topic_name.is_some() {
            return Err(MessageError::ReplyTopicNotAllowed);
        }
        if self.body.contains('\0')
            || self.body.trim().is_empty()
            || self.body.chars().count() > 4000
            || self
                .topic_name
                .as_ref()
                .is_some_and(|name| !topics::valid_name(name))
        {
            return Err(MessageError::InvalidInput);
        }
        Ok(())
    }
}

trait ValidateListMessages {
    fn validate(&self) -> Result<u16, MessageError>;
}

impl ValidateListMessages for ListMessagesQuery {
    fn validate(&self) -> Result<u16, MessageError> {
        let limit = self.limit.unwrap_or(50);
        if (self.after_seq.is_some() && self.before_seq.is_some())
            || self.as_of_seq.is_some_and(|seq| seq < 0)
            || self.after_seq.is_some_and(|seq| seq < 0)
            || self.before_seq.is_some_and(|seq| seq < 1)
            || !(1..=200).contains(&limit)
        {
            return Err(MessageError::InvalidInput);
        }
        Ok(limit)
    }
}

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
    fn replay(&self) -> Self {
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
            Self::DmPeerDeactivated => (StatusCode::CONFLICT, "dm_peer_deactivated"),
            Self::DmPeerAccessLapsed => (StatusCode::CONFLICT, "dm_peer_access_lapsed"),
            Self::ReplyTopicNotAllowed => (StatusCode::BAD_REQUEST, "reply_topic_not_allowed"),
            Self::ReplyParentNotFound => (StatusCode::NOT_FOUND, "reply_parent_not_found"),
            Self::ReplyChainNotFound => (StatusCode::NOT_FOUND, "reply_chain_not_found"),
            Self::TopicNotFound => (StatusCode::NOT_FOUND, "topic_not_found"),
            Self::NotFound => (StatusCode::NOT_FOUND, "channel not found"),
            Self::OrganizationUnavailable => (StatusCode::NOT_FOUND, "organization_unavailable"),
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
                        error: match rejection {
                            Self::ProjectionAdmissionRejected => "projection admission unavailable",
                            _ => "send admission unavailable",
                        }
                        .into(),
                    }),
                )
                    .into_response();
            }
        };
        (
            status,
            [(header::CACHE_CONTROL, "no-store")],
            Json(ErrorBody {
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

pub(crate) async fn require_visible_scoped(
    pool: &sqlx::PgPool,
    organization: Uuid,
    member: (Uuid, i64),
    channel: Uuid,
) -> Result<(), MessageError> {
    match channels::is_visible_scoped(pool, organization, member, channel).await? {
        Some(true) => Ok(()),
        Some(false) => Err(MessageError::NotFound),
        None => Err(MessageError::OrganizationUnavailable),
    }
}

pub(crate) async fn require_visible<'e, E: sqlx::PgExecutor<'e>>(
    executor: E,
    organization_id: Uuid,
    member: (Uuid, i64),
    channel_id: Uuid,
) -> Result<(), MessageError> {
    match channels::is_visible(executor, organization_id, member, channel_id).await? {
        Some(true) => Ok(()),
        Some(false) => Err(MessageError::NotFound),
        None => Err(MessageError::OrganizationUnavailable),
    }
}

/// The committed Message for this send key and whether the request matches its
/// original-send receipt (S5). Topic intent is normalized in SQL exactly as
/// Topics derive `name_key`; a Reply carries none.
async fn receipt<'e, E: sqlx::PgExecutor<'e>>(
    executor: E,
    organization_id: Uuid,
    sender: Uuid,
    channel_id: Uuid,
    input: &SendMessageRequest,
) -> Result<Option<(Message, bool)>, sqlx::Error> {
    use sqlx::Row;
    sqlx::query(&mentions::page_sql(
        "SELECT id, channel_id, seq, version, deleted, client_message_id, sender, body, topic_id, reply_to_id AS reply_to, reply_root_id, \
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at, \
         send_digest = fukulow_send_digest($4, $5, lower($6 COLLATE \"C\"), $7) AS same_intent \
         FROM messages WHERE organization_id = $1 AND sender = $2 AND client_message_id = $3",
        "p.seq",
    ))
    .bind(organization_id)
    .bind(sender)
    .bind(input.client_message_id)
    .bind(channel_id)
    .bind(&input.body)
    .bind(input.topic_name.as_deref())
    .bind(input.reply_to)
    .try_map(|row| Ok((message_from_row(&row)?, row.try_get("same_intent")?)))
    .fetch_optional(executor)
    .await
}

async fn existing<'e, E: sqlx::PgExecutor<'e>>(
    executor: E,
    organization_id: Uuid,
    sender: Uuid,
    client_message_id: Uuid,
) -> Result<Option<Message>, sqlx::Error> {
    sqlx::query(&mentions::page_sql(
        "SELECT id, channel_id, seq, version, deleted, client_message_id, sender, body, topic_id, reply_to_id AS reply_to, reply_root_id, \
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at \
         FROM messages WHERE organization_id = $1 AND sender = $2 AND client_message_id = $3",
        "p.seq",
    ))
    .bind(organization_id)
    .bind(sender)
    .bind(client_message_id)
    .try_map(|row| message_from_row(&row))
    .fetch_optional(executor)
    .await
}

async fn persist(
    pool: &sqlx::PgPool,
    delivery: &Delivery,
    organization_id: Uuid,
    sender: (Uuid, i64),
    channel_id: Uuid,
    input: SendMessageRequest,
    waiter: admission::SendWaiter,
) -> Result<Message, MessageError> {
    let _permit = waiter.acquire().await?;
    tokio::time::timeout(
        admission::WORK_TIMEOUT,
        persist_admitted(
            pool,
            delivery,
            organization_id,
            sender,
            channel_id,
            input,
            _permit,
        ),
    )
    .await
    .map_err(|_| {
        tracing::warn!(target: "fukulow", event = "work_deadline_expired", operation = "send");
        MessageError::Database(sqlx::Error::Io(std::io::ErrorKind::TimedOut.into()))
    })?
}

async fn persist_admitted(
    pool: &sqlx::PgPool,
    delivery: &Delivery,
    organization_id: Uuid,
    sender: (Uuid, i64),
    channel_id: Uuid,
    input: SendMessageRequest,
    permit: admission::Permit,
) -> Result<Message, MessageError> {
    let mut tx = commit::Transaction::begin(pool, permit, "BEGIN", Some(organization_id)).await?;
    require_visible(tx.connection()?, organization_id, sender, channel_id).await?;
    let history_generation = history::validate(
        tx.connection()?,
        organization_id,
        channel_id,
        input.history_generation,
        None,
    )
    .await?;
    let member = sender;
    let sender = sender.0;
    if existing(
        tx.connection()?,
        organization_id,
        sender,
        input.client_message_id,
    )
    .await?
    .is_some()
    {
        tx.rollback().await?;
        // Reauthorize and resolve names together in the canonical read snapshot.
        return committed(pool, organization_id, member, channel_id, &input)
            .await?
            .ok_or(MessageError::Database(sqlx::Error::RowNotFound));
    }
    let targets = mentions::extract(&input.body);
    let accepted = if let Some((grants, accepted)) = channels::dms::send_locks(
        tx.connection()?,
        organization_id,
        member,
        channel_id,
        &targets,
    )
    .await
    .map_err(dm_error)?
    {
        if input.topic_name.is_some() {
            return Err(MessageError::DmTopicsNotAllowed);
        }
        channels::dms::eligible_peer(tx.connection()?, organization_id, sender, &grants)
            .await
            .map_err(dm_error)?;
        channels::dms::discovery::bump(tx.connection()?, organization_id, channel_id, &grants)
            .await?;
        accepted
    } else {
        let (visible, archived, accepted) = channels::authorize_send_targets(
            tx.connection()?,
            organization_id,
            member,
            channel_id,
            &targets,
        )
        .await?;
        match visible {
            Some(true) => {}
            Some(false) => return Err(MessageError::NotFound),
            None => return Err(MessageError::OrganizationUnavailable),
        }
        if archived {
            // Another send can commit before our Channel lock is granted.
            // Resolve its receipt in the locked state before refusing new work.
            let canonical = receipt(
                tx.connection()?,
                organization_id,
                sender,
                channel_id,
                &input,
            )
            .await?;
            tx.rollback().await?;
            return match canonical {
                Some((message, true)) => Ok(message),
                Some((_, false)) => Err(MessageError::Conflict),
                None => Err(MessageError::ChannelArchived),
            };
        }
        accepted
    };
    #[cfg(test)]
    tests::removal::pause(input.client_message_id).await;
    // Read before waiting for the Channel barrier: an uncommitted parent is absent,
    // never a foreign-key wait or an implicitly accepted optimistic client id.
    replies::parent_location(
        tx.connection()?,
        organization_id,
        channel_id,
        input.reply_to,
    )
    .await?;
    #[cfg(test)]
    tests::history::pause(input.client_message_id, "reply_parent").await;
    // Bound every subsequent lock wait, including the counter and idempotency key.
    commit::lock(tx.connection()?, organization_id, channel_id, false).await?;
    // A committed parent may have moved while this Reply waited for the writer.
    let parent = replies::parent_location(
        tx.connection()?,
        organization_id,
        channel_id,
        input.reply_to,
    )
    .await?;
    let seq = log::allocate(tx.connection()?, organization_id, channel_id).await?;
    let topic_id = if let Some((topic, _)) = parent {
        topic
    } else {
        topics::join(
            tx.connection()?,
            organization_id,
            channel_id,
            Some(seq),
            input.topic_name.as_deref(),
        )
        .await?
    };
    let reply_root_id = parent.map(|(_, root)| root);
    let message = sqlx::query(
        "INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body, topic_id, reply_to_id, reply_root_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
         ON CONFLICT (organization_id, sender, client_message_id) DO NOTHING \
         RETURNING id, channel_id, seq, version, deleted, client_message_id, sender, body, topic_id, reply_to_id AS reply_to, reply_root_id, \
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at, '[]'::text AS mentions, $11::uuid AS history_generation",
    ).bind(organization_id).bind(Uuid::new_v4()).bind(channel_id).bind(seq).bind(sender)
        .bind(input.client_message_id).bind(&input.body).bind(topic_id).bind(input.reply_to).bind(reply_root_id).bind(history_generation).try_map(|row| message_from_row(&row))
        .fetch_optional(tx.connection()?).await?;
    if let Some(mut message) = message {
        search::SearchEngine::index_send(&mut tx, organization_id, message.id).await?;
        log::create(tx.connection()?, organization_id, &message).await?;
        mentions::store(tx.connection()?, organization_id, &mut message, &accepted).await?;
        topics::record(tx.connection()?, organization_id, topic_id, seq).await?;
        // Arm before COMMIT: cancellation or an ambiguous commit error must not leave
        // connected subscribers silently missing a possibly committed message.
        let mut notification =
            delivery.notification(organization_id, channel_id, message.created_seq);
        if let Err(error) = commit::finish(tx, input.client_message_id).await {
            if commit::definitely_rolled_back(&error) {
                notification.complete();
            }
            return Err(error.into());
        }
        delivery.channel_access.activity.message(
            pool.clone(),
            organization_id,
            channel_id,
            sender,
            message.created_seq,
        );
        notification.spawn(pool.clone(), message.clone());
        return Ok(message);
    }
    tx.rollback().await?;
    // The unique-key conflict implies a committed winner; absence is an invariant failure.
    committed(pool, organization_id, member, channel_id, &input)
        .await?
        .ok_or(MessageError::Database(sqlx::Error::RowNotFound))
}

pub(crate) use delivery::{LiveMessage, LiveQueue};

async fn latest_seq(
    pool: &sqlx::PgPool,
    organization: Uuid,
    channel: Uuid,
    permit: admission::Permit,
) -> Result<i64, sqlx::Error> {
    // A post-failure subscription must not snapshot behind an unresolved COMMIT.
    // Take a fresh READ COMMITTED snapshot *after* acquiring the shared barrier.
    let mut tx =
        commit::Transaction::begin(pool, permit, "BEGIN ISOLATION LEVEL READ COMMITTED", None)
            .await?;
    commit::lock(tx.connection()?, organization, channel, true).await?;
    let sql = "SELECT seq FROM channel_message_sequences \
                   WHERE organization_id = $1 AND channel_id = $2";
    let seq = sqlx::query_scalar::<_, i64>(sql)
        .bind(organization)
        .bind(channel)
        .fetch_optional(tx.connection()?)
        .await?
        .unwrap_or(0);
    tx.commit().await?;
    Ok(seq)
}

const REPLAY_PAGE_SIZE: i64 = 50;

pub(crate) use log::{authorized_replay_page, replay_page};

#[cfg(test)]
mod tests;

fn dm_error(error: ApiError) -> MessageError {
    match error.1 {
        "organization_unavailable" => MessageError::OrganizationUnavailable,
        "channel not found" => MessageError::NotFound,
        "dm_peer_deactivated" => MessageError::DmPeerDeactivated,
        "dm_peer_access_lapsed" => MessageError::DmPeerAccessLapsed,
        _ => MessageError::Database(sqlx::Error::Protocol("DM authorization failed".into())),
    }
}

async fn reject_dm_topics(
    connection: &mut sqlx::PgConnection,
    organization: Uuid,
    channel: Uuid,
) -> Result<(), MessageError> {
    if channels::dms::is_dm(connection, organization, channel).await? {
        Err(MessageError::DmTopicsNotAllowed)
    } else {
        Ok(())
    }
}
async fn reject_dm_topics_scoped(
    state: &AppState,
    auth: &Auth,
    channel: Uuid,
) -> Result<(), MessageError> {
    let org = auth.identity.organization.organization_id;
    crate::database::organization_read_only(
        &state.pool,
        org,
        async |tx: &mut sqlx::PgConnection| {
            require_visible(
                &mut *tx,
                org,
                (auth.identity.member.id, auth.membership_revision),
                channel,
            )
            .await?;
            reject_dm_topics(tx, org, channel).await
        },
    )
    .await
}
