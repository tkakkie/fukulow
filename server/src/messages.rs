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
    auth::{ApiError, ApiJson, Auth, ErrorBody},
    channels,
};

mod delivery;
pub use delivery::Delivery;
#[cfg(test)]
pub(crate) use delivery::{PublicationGate, pause_publication};

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
    /// Always null in this contract; topics are deferred.
    #[schema(schema_with = null_schema)]
    #[sqlx(skip)]
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
    /// 1..=4000 Unicode scalar values; no NUL or whitespace-only body. Stored without trimming.
    #[schema(min_length = 1, max_length = 4000)]
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
#[utoipa::path(get, path = "/api/v1/channels/{id}/messages",
    params(("id" = Uuid, Path, description = "Channel id"), ListMessagesQuery),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Page of Channel Messages in ascending sequence order with directional has_more", body = MessagePage),
        (status = 400, description = "Invalid Channel id, sequence cursors, or page limit; after_seq and before_seq cannot be combined", body = ErrorBody),
        (status = 401, description = "Missing, invalid, ambiguous, expired, or revoked session credential", body = ErrorBody),
        (status = 404, description = "Channel does not exist or is private and the caller is not a member; the response does not reveal whether the Channel exists", body = ErrorBody),
        (status = 500, description = "Database failure while resolving the session, checking Channel visibility, or listing Messages", body = ErrorBody)))]
pub async fn list_messages(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<Uuid>, PathRejection>,
    query: Result<Query<ListMessagesQuery>, QueryRejection>,
) -> Result<Response, MessageError> {
    let Path(channel_id) = path.map_err(|_| MessageError::InvalidInput)?;
    let Query(query) = query.map_err(|_| MessageError::InvalidInput)?;
    let limit = query.validate()?;
    let organization_id = auth.identity.organization.organization_id;
    require_visible(
        &state.pool,
        organization_id,
        auth.identity.member.id,
        channel_id,
    )
    .await?;
    let ascending = query.after_seq.is_some();
    let sql = if ascending {
        "SELECT id, channel_id, seq, client_message_id, sender, body, \
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at \
         FROM messages WHERE organization_id = $1 AND channel_id = $2 AND seq > $3 \
         ORDER BY seq ASC LIMIT $4"
    } else {
        "SELECT id, channel_id, seq, client_message_id, sender, body, \
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
        .fetch_all(&state.pool)
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
}

/// Send a message to a visible channel; topic_id is always null.
/// The session supplies organization and sender. A successful retry returns the same
/// canonical message with 201, allocating no new sequence and publishing no new event.
/// A reused client_message_id with different body or channel returns 409.
#[utoipa::path(post, path = "/api/v1/channels/{id}/messages", request_body = SendMessageRequest,
    params(("id" = Uuid, Path, description = "Channel id")),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 201, description = "Confirmed Message; an idempotent retry returns the same Message and sequence", body = Message),
        (status = 400, description = "Invalid Channel id, Message JSON or fields, or body that is empty or whitespace-only, contains NUL, or exceeds 4000 Unicode scalar values", body = ErrorBody),
        (status = 401, description = "Missing, invalid, ambiguous, expired, or revoked session credential", body = ErrorBody),
        (status = 404, description = "Channel does not exist or is private and the caller is not a member; the response does not reveal whether the Channel exists", body = ErrorBody),
        (status = 409, description = "Client message id reused with different body or channel", body = ErrorBody),
        (status = 413, description = "Message send request body exceeds the size limit", body = ErrorBody),
        (status = 415, description = "Sending a Message requires an application/json content type", body = ErrorBody),
        (status = 500, description = "Database or worker failure while resolving the session, checking Channel visibility, or persisting the Message", body = ErrorBody)))]
pub async fn send_message(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<Uuid>, PathRejection>,
    ApiJson(input): ApiJson<SendMessageRequest>,
) -> Result<Response, MessageError> {
    let Path(channel_id) = path.map_err(|_| MessageError::InvalidInput)?;
    input.validate()?;
    let organization_id = auth.identity.organization.organization_id;
    let sender = auth.identity.member.id;
    require_visible(&state.pool, organization_id, sender, channel_id).await?;
    // Finish persistence even if the HTTP caller disconnects; notification is detached.
    let message = tokio::spawn(async move {
        persist(
            &state.pool,
            &state.message_delivery,
            organization_id,
            sender,
            channel_id,
            input,
        )
        .await
    })
    .await
    .map_err(|_| MessageError::Database(sqlx::Error::WorkerCrashed))??;
    Ok((
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(message),
    )
        .into_response())
}

impl SendMessageRequest {
    fn validate(&self) -> Result<(), MessageError> {
        if self.body.contains('\0')
            || self.body.trim().is_empty()
            || self.body.chars().count() > 4000
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
    NotFound,
    Conflict,
    Database(sqlx::Error),
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
            Self::NotFound => (StatusCode::NOT_FOUND, "channel not found"),
            Self::Conflict => (
                StatusCode::CONFLICT,
                "client message id reused with different body or channel",
            ),
            Self::Database(error) => return ApiError::from(error).into_response(),
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

pub(crate) async fn require_visible(
    pool: &sqlx::PgPool,
    organization_id: Uuid,
    member_id: Uuid,
    channel_id: Uuid,
) -> Result<(), MessageError> {
    if !channels::is_visible(pool, organization_id, member_id, channel_id).await? {
        return Err(MessageError::NotFound);
    }
    Ok(())
}

async fn existing<'e, E: sqlx::PgExecutor<'e>>(
    executor: E,
    organization_id: Uuid,
    sender: Uuid,
    client_message_id: Uuid,
) -> Result<Option<Message>, sqlx::Error> {
    sqlx::query_as(
        "SELECT id, channel_id, seq, client_message_id, sender, body, \
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
) -> Result<Message, MessageError> {
    if message.channel_id != channel_id || message.body != input.body {
        return Err(MessageError::Conflict);
    }
    Ok(message)
}

async fn persist(
    pool: &sqlx::PgPool,
    delivery: &Delivery,
    organization_id: Uuid,
    sender: Uuid,
    channel_id: Uuid,
    input: SendMessageRequest,
) -> Result<Message, MessageError> {
    let mut tx = pool.begin().await?;
    if let Some(message) =
        existing(&mut *tx, organization_id, sender, input.client_message_id).await?
    {
        tx.rollback().await?;
        return canonical(message, channel_id, &input);
    }
    // Row locking serializes only sends in this channel. Both allocation and insertion
    // roll back together, including a concurrent duplicate that loses the unique-key race.
    let seq: i64 = sqlx::query_scalar(
        "INSERT INTO channel_message_sequences (organization_id, channel_id, seq) VALUES ($1, $2, 1) \
         ON CONFLICT (organization_id, channel_id) DO UPDATE SET seq = channel_message_sequences.seq + 1 \
         RETURNING seq",
    ).bind(organization_id).bind(channel_id).fetch_one(&mut *tx).await?;
    let message = sqlx::query_as::<_, Message>(
        "INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) \
         ON CONFLICT (organization_id, sender, client_message_id) DO NOTHING \
         RETURNING id, channel_id, seq, client_message_id, sender, body, \
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at",
    ).bind(organization_id).bind(Uuid::new_v4()).bind(channel_id).bind(seq).bind(sender)
        .bind(input.client_message_id).bind(&input.body).fetch_optional(&mut *tx).await?;
    if let Some(message) = message {
        // Arm before COMMIT: cancellation or an ambiguous commit error must not leave
        // connected subscribers silently missing a possibly committed message.
        let notification = delivery.notification(organization_id, channel_id);
        tx.commit().await?;
        notification.spawn(pool.clone(), message.clone());
        return Ok(message);
    }
    tx.rollback().await?;
    // The unique-key conflict implies a committed winner; absence is an invariant failure.
    let message = existing(pool, organization_id, sender, input.client_message_id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;
    canonical(message, channel_id, &input)
}

pub(crate) use delivery::LiveQueue;

pub(crate) async fn latest_seq(
    pool: &sqlx::PgPool,
    organization: Uuid,
    channel: Uuid,
) -> Result<i64, sqlx::Error> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT seq FROM channel_message_sequences WHERE organization_id = $1 AND channel_id = $2",
    )
    .bind(organization)
    .bind(channel)
    .fetch_optional(pool)
    .await?
    .unwrap_or(0))
}

pub(crate) async fn replay_page(
    pool: &sqlx::PgPool,
    organization: Uuid,
    channel: Uuid,
    after: i64,
    through: i64,
) -> Result<Vec<Message>, sqlx::Error> {
    sqlx::query_as(
        "SELECT id, channel_id, seq, client_message_id, sender, body, \
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at \
         FROM messages WHERE organization_id = $1 AND channel_id = $2 AND seq > $3 AND seq <= $4 \
         ORDER BY seq ASC LIMIT 50",
    )
    .bind(organization)
    .bind(channel)
    .bind(after)
    .bind(through)
    .fetch_all(pool)
    .await
}

#[cfg(test)]
mod tests;
