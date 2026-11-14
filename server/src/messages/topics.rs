use super::*;

pub(crate) mod projection;
pub use projection::{list_timeline, list_topics, topic_summary};

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TopicSummary {
    pub id: Uuid,
    pub name: String,
    pub first_seq: i64,
    /// W-relative display position; unaffected by Messages after the enclosing as_of_seq.
    pub last_seq: i64,
    /// Absolute count at the enclosing as_of_seq, excluding later Messages.
    pub message_count: i64,
    /// Current Member position, independent of the Channel main timeline.
    pub read_seq: i64,
    /// Other senders' Messages above read_seq, bounded by the enclosing as_of_seq.
    pub unread_count: i64,
    pub latest_message: Message,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TimelineItem {
    Message { message: Message },
    Topic { topic: TopicSummary },
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct TimelinePage {
    pub as_of_seq: i64,
    /// Ascending W-relative positions, newest last. Continue older with the first position.
    pub items: Vec<TimelineItem>,
    pub has_more: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct TopicPage {
    pub as_of_seq: i64,
    pub topics: Vec<TopicSummary>,
    pub has_more: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct TopicSummaryResponse {
    pub as_of_seq: i64,
    pub topic: TopicSummary,
}

/// A fixed immutable-Message projection; never an unfiltered sync-cursor page.
#[derive(Debug, Serialize, Deserialize, IntoParams, ToSchema)]
#[into_params(parameter_in = Query)]
pub struct ListProjectionQuery {
    /// Omit on the initial page to choose W under the commit barrier; future W is invalid.
    #[param(minimum = 0)]
    #[schema(minimum = 0)]
    pub as_of_seq: Option<i64>,
    /// Exclusive W-relative position. Requires as_of_seq; never use a live-moved position.
    #[param(minimum = 1)]
    #[schema(minimum = 1)]
    pub before_position: Option<i64>,
    #[param(minimum = 1, maximum = 200, default = 50)]
    #[schema(minimum = 1, maximum = 200)]
    pub limit: Option<u16>,
}

impl ListProjectionQuery {
    fn validate(&self) -> Result<u16, MessageError> {
        let limit = self.limit.unwrap_or(50);
        if !(1..=200).contains(&limit)
            || self.as_of_seq.is_some_and(|w| w < 0)
            || self.before_position.is_some_and(|p| p < 1)
            || (self.before_position.is_some() && self.as_of_seq.is_none())
        {
            return Err(MessageError::InvalidInput);
        }
        Ok(limit)
    }
}

pub(super) async fn name_key<'e, E: sqlx::PgExecutor<'e>>(
    executor: E,
    organization: Uuid,
    topic: Option<Uuid>,
) -> Result<Option<String>, sqlx::Error> {
    match topic {
        None => Ok(None),
        Some(topic) => {
            sqlx::query_scalar("SELECT name_key FROM topics WHERE organization_id = $1 AND id = $2")
                .bind(organization)
                .bind(topic)
                .fetch_one(executor)
                .await
                .map(Some)
        }
    }
}

pub(super) async fn join(
    connection: &mut sqlx::PgConnection,
    organization: Uuid,
    channel: Uuid,
    seq: i64,
    name: Option<&str>,
) -> Result<Option<Uuid>, sqlx::Error> {
    let Some(name) = name else { return Ok(None) };
    sqlx::query(
        "INSERT INTO topics (organization_id, channel_id, id, name, first_seq, last_seq, message_count) \
         VALUES ($1, $2, $3, $4, $5, $5, 1) ON CONFLICT (organization_id, channel_id, name_key) DO NOTHING",
    ).bind(organization).bind(channel).bind(Uuid::new_v4()).bind(name).bind(seq)
        .execute(&mut *connection).await?;
    sqlx::query_scalar("SELECT id FROM topics WHERE organization_id = $1 AND channel_id = $2 AND name_key = lower($3 COLLATE \"C\")")
        .bind(organization).bind(channel).bind(name).fetch_one(connection).await.map(Some)
}

pub(super) async fn record(
    connection: &mut sqlx::PgConnection,
    organization: Uuid,
    topic: Option<Uuid>,
    seq: i64,
) -> Result<(), sqlx::Error> {
    if let Some(topic) = topic {
        // A new Topic already includes its first Message; the Channel counter lock
        // serializes subsequent updates, and failed/duplicate sends roll back both.
        sqlx::query(
            "UPDATE topics SET last_seq = $3, message_count = message_count + 1 \
                     WHERE organization_id = $1 AND id = $2 AND last_seq <> $3",
        )
        .bind(organization)
        .bind(topic)
        .bind(seq)
        .execute(connection)
        .await?;
    }
    Ok(())
}

/// Topic-filtered history is cursor-neutral; use unfiltered GET /messages for gap fill.
#[utoipa::path(get, path = "/api/v1/orgs/{org}/channels/{id}/topics/{topic_id}/messages",
    params(("org" = Uuid, Path), ("id" = Uuid, Path), ("topic_id" = Uuid, Path), ListMessagesQuery),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Ascending Topic Messages; exclusive after_seq XOR before_seq, default 50/max 200, directional has_more; never advances the sync cursor", body = MessagePage),
        (status = 400, description = "Invalid Organization id, Channel id, Topic id, conflicting cursors or limit", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 404, description = "organization_unavailable, channel not found or topic_not_found; foreign and unknown Topics are identical", body = ErrorBody),
        (status = 503, description = "Projection watermark admission unavailable; Retry-After gives retry seconds", body = ErrorBody,
            headers(("Retry-After" = inline(crate::auth::RetryAfterSeconds), description = "Jittered retry delay in seconds (1 through 5)"))),
        (status = 500, description = "Database failure or barrier timeout reading Topic history", body = ErrorBody)))]
pub async fn topic_history(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid, Uuid)>, PathRejection>,
    query: Result<Query<ListMessagesQuery>, QueryRejection>,
) -> Result<Response, MessageError> {
    let Path((_, channel, topic)) = path.map_err(|_| MessageError::InvalidInput)?;
    let Query(query) = query.map_err(|_| MessageError::InvalidInput)?;
    let limit = query.validate()?;
    let organization = auth.identity.organization.organization_id;
    require_visible_scoped(
        &state.pool,
        organization,
        (auth.identity.member.id, auth.membership_revision),
        channel,
    )
    .await?;
    let w = watermark(&state, organization, channel).await?;
    crate::database::organization_read_only(&state.pool, organization, async |tx: &mut sqlx::PgConnection| {
        require_visible(
            &mut *tx,
            organization,
            (auth.identity.member.id, auth.membership_revision),
            channel,
        )
        .await?;
        reject_dm_topics(tx,organization,channel).await?;
        let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM topics WHERE organization_id = $1 AND channel_id = $2 AND id = $3)")
            .bind(organization).bind(channel).bind(topic).fetch_one(&mut *tx).await?;
        if !exists {
            return Err(MessageError::TopicNotFound);
        }
        let ascending = query.after_seq.is_some();
        let (comparison, order, cursor) = if ascending {
            (">", "ASC", query.after_seq.unwrap_or(0))
        } else {
            (
                "<=",
                "DESC",
                query.before_seq.map(|s| s - 1).unwrap_or(i64::MAX),
            )
        };
        let sql = format!(
            "SELECT id, channel_id, seq, client_message_id, sender, body, topic_id, reply_to_id AS reply_to, reply_root_id, \
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at \
            FROM messages WHERE organization_id = $1 AND channel_id = $2 AND topic_id = $3 AND seq {comparison} $4 AND seq <= $6 \
            ORDER BY seq {order} LIMIT $5"
        );
        let mut messages = sqlx::query_as::<_, Message>(&sql)
            .bind(organization)
            .bind(channel)
            .bind(topic)
            .bind(cursor)
            .bind(i64::from(limit) + 1)
            .bind(w)
            .fetch_all(&mut *tx)
            .await?;
        let has_more = messages.len() > usize::from(limit);
        messages.truncate(usize::from(limit));
        if !ascending {
            messages.reverse()
        }
        Ok((
            [(header::CACHE_CONTROL, "no-store")],
            Json(MessagePage { messages, has_more }),
        )
            .into_response())
    })
    .await
}

// Keep HTTP admission rejection distinct from database/barrier work timeouts.
pub(super) async fn watermark(
    state: &AppState,
    organization: Uuid,
    channel: Uuid,
) -> Result<i64, MessageError> {
    state.message_delivery.latest_seq(&state.pool, organization, channel).await.map_err(|error| {
        if matches!(&error, sqlx::Error::Io(error) if error.kind() == std::io::ErrorKind::WouldBlock) {
            MessageError::ProjectionAdmissionRejected
        } else {
            MessageError::Database(error)
        }
    })
}
