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
mod limiter;
pub use limiter::SendLimit;
pub(crate) mod replies;
pub use replies::{ReplyChainPage, ReplyChainQuery, reply_chain};
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

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema, sqlx::FromRow)]
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
    #[schema(required = true)]
    pub topic_id: Option<Uuid>,
    /// Confirmed parent Message; null for a non-Reply.
    #[schema(required = true)]
    pub reply_to: Option<Uuid>,
    /// Stable root even when the parent is outside the loaded window; null for a non-Reply.
    #[schema(required = true)]
    pub reply_root_id: Option<Uuid>,
}

/// Idempotency key: (organization, sender, client_message_id), derived from the session.
/// Matching body, Channel, normalized Topic name and reply target returns the canonical Message/sequence;
/// changing any of them returns 409.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SendMessageRequest {
    pub client_message_id: Uuid,
    /// 1..=4000 Unicode scalar values; no NUL or whitespace-only body. Stored without trimming.
    #[schema(min_length = 1, max_length = 4000)]
    pub body: String,
    /// Join or create a Topic in this Channel. Omitted/null sends without a Topic unless replying.
    /// 1..=60 Unicode scalars, no NUL or surrounding/only trim whitespace; ASCII case folds.
    #[schema(min_length = 1, max_length = 60)]
    pub topic_name: Option<String>,
    /// Confirmed parent in this Organization/Channel. Omitted/null is a non-Reply.
    /// A Reply inherits its parent's Topic; topic_name must be omitted/null.
    pub reply_to: Option<Uuid>,
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
    #[schema(minimum = 1, maximum = 200)]
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
#[utoipa::path(get, path = "/api/v1/orgs/{org}/channels/{id}/messages",
    params(("org" = Uuid, Path, description = "Organization id"), ("id" = Uuid, Path, description = "Channel id"), ListMessagesQuery),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Page of Channel Messages in ascending sequence order with directional has_more", body = MessagePage),
        (status = 400, description = "Malformed Organization id, invalid Channel id, sequence cursors, or page limit; after_seq and before_seq cannot be combined", body = ErrorBody),
        (status = 401, description = "Missing, invalid, expired, or revoked Account Session credential", body = ErrorBody),
        (status = 404, description = "organization_unavailable for an unavailable Organization; otherwise Channel does not exist or is private and the caller is not a member; the response does not reveal whether the Channel exists", body = ErrorBody),
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
        let ascending = query.after_seq.is_some();
        let sql = if ascending {
            "SELECT id, channel_id, seq, client_message_id, sender, body, topic_id, reply_to_id AS reply_to, reply_root_id, \
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at \
             FROM messages WHERE organization_id = $1 AND channel_id = $2 AND seq > $3 \
             ORDER BY seq ASC LIMIT $4"
        } else {
            "SELECT id, channel_id, seq, client_message_id, sender, body, topic_id, reply_to_id AS reply_to, reply_root_id, \
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at \
             FROM messages WHERE organization_id = $1 AND channel_id = $2 \
               AND seq <= $3 ORDER BY seq DESC LIMIT $4"
        };
        let cursor = if ascending {
            query.after_seq.unwrap_or(0)
        } else {
            // Convert exclusive before to an inclusive upper bound; validation guarantees >= 1.
            query.before_seq.map(|seq| seq - 1).unwrap_or(i64::MAX)
        };
        let mut messages = sqlx::query_as::<_, Message>(sql)
            .bind(organization_id)
            .bind(channel_id)
            .bind(cursor)
            .bind(i64::from(limit) + 1)
            .fetch_all(&mut *tx)
            .await?;
        let has_more = messages.len() > usize::from(limit);
        messages.truncate(usize::from(limit));
        if !ascending {
            messages.reverse();
        }
        Ok((
            [(header::CACHE_CONTROL, "no-store")],
            Json(MessagePage { messages, has_more }),
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
        (status = 409, description = "Client message id reused with different body, Channel, normalized Topic name or reply target; new DM send: dm_peer_deactivated or dm_peer_access_lapsed", body = ErrorBody),
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
            require_visible(&mut *tx, organization_id, sender, channel_id).await?;
            let Some(message) =
                existing(&mut *tx, organization_id, sender.0, input.client_message_id).await?
            else {
                return Ok(None);
            };
            let name_key = if message.reply_to.is_none() {
                topics::name_key(&mut *tx, organization_id, message.topic_id).await?
            } else {
                None
            };
            canonical(message, channel_id, input, name_key).map(Some)
        },
    )
    .await
}

impl SendMessageRequest {
    fn validate(&self) -> Result<(), MessageError> {
        if self.reply_to.is_some() && self.topic_name.is_some() {
            return Err(MessageError::ReplyTopicNotAllowed);
        }
        if self.body.contains('\0')
            || self.body.trim().is_empty()
            || self.body.chars().count() > 4000
            || self.topic_name.as_ref().is_some_and(|name| {
                name.is_empty()
                    || name.contains('\0')
                    || name.trim() != name
                    || name.chars().count() > 60
            })
        {
            return Err(MessageError::InvalidInput);
        }
        Ok(())
    }
}

impl ListMessagesQuery {
    fn validate(&self) -> Result<u16, MessageError> {
        let limit = self.limit.unwrap_or(50);
        if (self.after_seq.is_some() && self.before_seq.is_some())
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

async fn existing<'e, E: sqlx::PgExecutor<'e>>(
    executor: E,
    organization_id: Uuid,
    sender: Uuid,
    client_message_id: Uuid,
) -> Result<Option<Message>, sqlx::Error> {
    sqlx::query_as(
        "SELECT id, channel_id, seq, client_message_id, sender, body, topic_id, reply_to_id AS reply_to, reply_root_id, \
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at \
         FROM messages WHERE organization_id = $1 AND sender = $2 AND client_message_id = $3",
    )
    .bind(organization_id)
    .bind(sender)
    .bind(client_message_id)
    .fetch_optional(executor)
    .await
}

fn canonical(
    message: Message,
    channel_id: Uuid,
    input: &SendMessageRequest,
    name_key: Option<String>,
) -> Result<Message, MessageError> {
    if message.channel_id != channel_id
        || message.body != input.body
        || message.reply_to != input.reply_to
        || (input.reply_to.is_none()
            && name_key
                != input
                    .topic_name
                    .as_ref()
                    .map(|name| name.to_ascii_lowercase()))
    {
        return Err(MessageError::Conflict);
    }
    Ok(message)
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
        persist_admitted(pool, delivery, organization_id, sender, channel_id, input, _permit),
    )
    .await
    .map_err(|_| {
        eprintln!("work_deadline_expired operation=send organization={organization_id} channel={channel_id}");
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
    let dm_grants =
        channels::dms::send_locks(tx.connection()?, organization_id, sender, channel_id)
            .await
            .map_err(dm_error)?;
    // DM locks already checked and retain the current sender and participant
    // grant. The ordinary authorizer would repeat those three locked reads.
    if dm_grants.is_none() {
        match channels::is_visible_for_write(tx.connection()?, organization_id, sender, channel_id)
            .await?
        {
            Some(true) => {}
            Some(false) => return Err(MessageError::NotFound),
            None => return Err(MessageError::OrganizationUnavailable),
        }
    }
    #[cfg(test)]
    tests::removal::pause(input.client_message_id).await;
    let member = sender;
    let sender = sender.0;
    if let Some(message) = existing(
        tx.connection()?,
        organization_id,
        sender,
        input.client_message_id,
    )
    .await?
    {
        let name_key = if message.reply_to.is_none() {
            topics::name_key(tx.connection()?, organization_id, message.topic_id).await?
        } else {
            None
        };
        tx.rollback().await?;
        return canonical(message, channel_id, &input, name_key);
    }
    if let Some(grants) = dm_grants {
        if input.topic_name.is_some() {
            return Err(MessageError::DmTopicsNotAllowed);
        }
        channels::dms::eligible_peer(tx.connection()?, organization_id, sender, &grants)
            .await
            .map_err(dm_error)?;
        channels::dms::discovery::bump(tx.connection()?, organization_id, channel_id, &grants)
            .await?;
    }
    // Read before waiting for the Channel barrier: an uncommitted parent is absent,
    // never a foreign-key wait or an implicitly accepted optimistic client id.
    let parent = replies::parent(
        tx.connection()?,
        organization_id,
        channel_id,
        input.reply_to,
    )
    .await?;
    // Bound every subsequent lock wait, including the counter and idempotency key.
    commit::lock(tx.connection()?, organization_id, channel_id, false).await?;
    // Row locking serializes only sends in this channel. Both allocation and insertion
    // roll back together, including a concurrent duplicate that loses the unique-key race.
    let seq: i64 = sqlx::query_scalar(
        "INSERT INTO channel_message_sequences (organization_id, channel_id, seq) VALUES ($1, $2, 1) \
         ON CONFLICT (organization_id, channel_id) DO UPDATE SET seq = channel_message_sequences.seq + 1 \
         RETURNING seq",
    ).bind(organization_id).bind(channel_id).fetch_one(tx.connection()?).await?;
    let topic_id = if let Some(parent) = &parent {
        parent.topic_id
    } else {
        topics::join(
            tx.connection()?,
            organization_id,
            channel_id,
            seq,
            input.topic_name.as_deref(),
        )
        .await?
    };
    let reply_root_id = parent.as_ref().map(|p| p.reply_root_id.unwrap_or(p.id));
    let message = sqlx::query_as::<_, Message>(
        "INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body, topic_id, reply_to_id, reply_root_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
         ON CONFLICT (organization_id, sender, client_message_id) DO NOTHING \
         RETURNING id, channel_id, seq, client_message_id, sender, body, topic_id, reply_to_id AS reply_to, reply_root_id, \
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at",
    ).bind(organization_id).bind(Uuid::new_v4()).bind(channel_id).bind(seq).bind(sender)
        .bind(input.client_message_id).bind(&input.body).bind(topic_id).bind(input.reply_to).bind(reply_root_id).fetch_optional(tx.connection()?).await?;
    if let Some(message) = message {
        topics::record(tx.connection()?, organization_id, topic_id, seq).await?;
        // Arm before COMMIT: cancellation or an ambiguous commit error must not leave
        // connected subscribers silently missing a possibly committed message.
        let mut notification = delivery.notification(organization_id, channel_id, message.seq);
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
            message.seq,
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

pub(crate) use delivery::LiveQueue;

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

pub(crate) async fn replay_page(
    pool: &sqlx::PgPool,
    organization: Uuid,
    channel: Uuid,
    after: i64,
    through: i64,
) -> Result<Vec<Message>, sqlx::Error> {
    let sql = "SELECT id, channel_id, seq, client_message_id, sender, body, topic_id, reply_to_id AS reply_to, reply_root_id, \
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at \
             FROM messages WHERE organization_id = $1 AND channel_id = $2 AND seq > $3 AND seq <= $4 \
             ORDER BY seq ASC LIMIT $5";
    crate::database::organization_statement(
        pool,
        sql,
        async |tx: &mut sqlx::PgConnection, sql: &str| {
            let sql = format!("{sql} ORDER BY seq");
            sqlx::query_as(&sql)
                .bind(organization)
                .bind(channel)
                .bind(after)
                .bind(through)
                .bind(REPLAY_PAGE_SIZE)
                .fetch_all(tx)
                .await
        },
    )
    .await
}

#[cfg(test)]
mod tests;

// A replay page snapshots authorization and Messages together, just like REST
// history. A separate check before this query cannot authorize its later data.
pub(crate) async fn authorized_replay_page(
    pool: &sqlx::PgPool,
    organization: Uuid,
    member: (Uuid, i64),
    channel: Uuid,
    after: i64,
    through: i64,
) -> Result<Vec<Message>, MessageError> {
    use sqlx::{FromRow, Row};
    let sql = format!(
        r#"WITH access AS MATERIALIZED (SELECT ({}) AS visible)
        SELECT access.visible,m.* FROM access LEFT JOIN LATERAL (
            SELECT id,channel_id,seq,client_message_id,sender,body,topic_id,reply_to_id AS reply_to,reply_root_id,
                to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
            FROM messages WHERE organization_id=$1 AND channel_id=$4 AND seq>$5 AND seq<=$6 AND access.visible
            ORDER BY seq LIMIT $7
        ) m ON true ORDER BY m.seq"#,
        channels::member_visibility_sql(false)
    );
    let rows = crate::database::organization_statement(
        pool,
        &sql,
        async |tx: &mut sqlx::PgConnection, sql: &str| {
            let sql = format!("{sql} ORDER BY seq");
            sqlx::query(&sql)
                .bind(organization)
                .bind(member.0)
                .bind(member.1)
                .bind(channel)
                .bind(after)
                .bind(through)
                .bind(REPLAY_PAGE_SIZE)
                .fetch_all(tx)
                .await
        },
    )
    .await?;
    match rows
        .first()
        .ok_or(sqlx::Error::RowNotFound)?
        .try_get::<Option<bool>, _>("visible")?
    {
        None => return Err(MessageError::OrganizationUnavailable),
        Some(false) => return Err(MessageError::NotFound),
        Some(true) => {}
    }
    let mut messages = Vec::new();
    for row in rows {
        if row.try_get::<Option<Uuid>, _>("id")?.is_some() {
            messages.push(Message::from_row(&row)?);
        }
    }
    Ok(messages)
}

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
