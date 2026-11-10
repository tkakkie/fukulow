use super::*;
use sqlx::Row;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct UnreadChannel {
    #[serde(flatten)]
    pub channel: channels::Channel,
    pub read_seq: i64,
    pub main_unread_count: i64,
    /// Channel badge: main-timeline Unread plus all Topic Unread.
    pub unread_count: i64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ChannelList {
    pub channels: Vec<UnreadChannel>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MarkReadRequest {
    /// Monotonic max, clamped to the latest committed Channel seq. Sending never marks read.
    #[schema(minimum = 0)]
    pub read_seq: i64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ReadPosition {
    pub read_seq: i64,
}

#[utoipa::path(get, path = "/api/v1/orgs/{org}/channels",
    params(("org" = Uuid, Path)),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Visible Channels with current Member positions and Unread counts; refetch on reconnect", body = ChannelList),
        (status = 400, description = "Malformed Organization id", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 404, description = "Non-Member, unknown Organization or deactivated Member: organization_unavailable", body = ErrorBody),
        (status = 500, description = "Database failure while listing visible Channels and Unread", body = ErrorBody)))]
pub async fn list_channels(
    State(state): State<AppState>,
    auth: Auth,
) -> Result<Response, ApiError> {
    let mut tx = state
        .pool
        .begin_with("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .await?;
    let channels = channels::visible_list(&mut *tx, &auth).await?;
    let ids = channels.iter().map(|c| c.id).collect::<Vec<_>>();
    // Two batched queries in one authorization/data snapshot, independent of the
    // number of Channels or Topics. No Message or position outside ids is read.
    let rows = sqlx::query(
        "SELECT p.channel_id, p.read_seq, \
         count(m.seq) FILTER (WHERE m.topic_id IS NULL AND m.seq > p.read_seq) AS main_unread_count, \
         count(m.seq) FILTER (WHERE m.seq > CASE WHEN m.topic_id IS NULL THEN p.read_seq \
             ELSE COALESCE(t.read_seq, p.initial_seq) END) AS unread_count \
         FROM channel_read_positions p \
         LEFT JOIN messages m ON m.organization_id = p.organization_id AND m.channel_id = p.channel_id AND m.sender <> p.member_id AND m.seq > p.initial_seq \
         LEFT JOIN topic_read_positions t ON t.organization_id = p.organization_id AND t.channel_id = p.channel_id \
             AND t.member_id = p.member_id AND t.topic_id = m.topic_id \
         WHERE p.organization_id = $1 AND p.member_id = $2 AND p.membership_revision = $3 AND p.channel_id = ANY($4) \
         GROUP BY p.channel_id, p.read_seq",
    ).bind(auth.identity.organization.organization_id).bind(auth.identity.member.id)
        .bind(auth.membership_revision).bind(&ids).fetch_all(&mut *tx).await?;
    let mut counts = std::collections::HashMap::new();
    for row in rows {
        counts.insert(
            row.try_get::<Uuid, _>("channel_id")?,
            (
                row.try_get::<i64, _>("read_seq")?,
                row.try_get::<i64, _>("main_unread_count")?,
                row.try_get::<i64, _>("unread_count")?,
            ),
        );
    }
    let mut result = Vec::with_capacity(channels.len());
    for channel in channels {
        let (read_seq, main_unread_count, unread_count) =
            counts.remove(&channel.id).ok_or(sqlx::Error::RowNotFound)?;
        result.push(UnreadChannel {
            channel,
            read_seq,
            main_unread_count,
            unread_count,
        });
    }
    tx.commit().await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(ChannelList { channels: result }),
    )
        .into_response())
}

#[utoipa::path(put, path = "/api/v1/orgs/{org}/channels/{id}/read", request_body = MarkReadRequest,
    params(("org" = Uuid, Path), ("id" = Uuid, Path)),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Monotonic Channel position for Messages without Topic only", body = ReadPosition),
        (status = 400, description = "Invalid ids, negative read_seq or malformed JSON", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 404, description = "organization_unavailable or channel not found", body = ErrorBody),
        (status = 413, description = "Request body exceeds size limit", body = ErrorBody),
        (status = 415, description = "Requires application/json", body = ErrorBody),
        (status = 503, description = "Watermark admission unavailable; Retry-After gives retry seconds", body = ErrorBody,
            headers(("Retry-After" = inline(crate::auth::RetryAfterSeconds), description = "Retry delay in seconds"))),
        (status = 500, description = "Database failure or watermark timeout", body = ErrorBody)))]
pub async fn mark_channel_read(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid)>, PathRejection>,
    ApiJson(input): ApiJson<MarkReadRequest>,
) -> Result<Response, MessageError> {
    let Path((_, channel)) = path.map_err(|_| MessageError::InvalidInput)?;
    mark(&state, &auth, channel, None, input).await
}

#[utoipa::path(put, path = "/api/v1/orgs/{org}/channels/{id}/topics/{topic_id}/read", request_body = MarkReadRequest,
    params(("org" = Uuid, Path), ("id" = Uuid, Path), ("topic_id" = Uuid, Path)),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Monotonic position for this Topic only", body = ReadPosition),
        (status = 400, description = "Invalid ids, negative read_seq or malformed JSON", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 404, description = "organization_unavailable, channel not found or topic_not_found; unknown and foreign Topics are identical", body = ErrorBody),
        (status = 413, description = "Request body exceeds size limit", body = ErrorBody),
        (status = 415, description = "Requires application/json", body = ErrorBody),
        (status = 503, description = "Watermark admission unavailable; Retry-After gives retry seconds", body = ErrorBody,
            headers(("Retry-After" = inline(crate::auth::RetryAfterSeconds), description = "Retry delay in seconds"))),
        (status = 500, description = "Database failure or watermark timeout", body = ErrorBody)))]
pub async fn mark_topic_read(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid, Uuid)>, PathRejection>,
    ApiJson(input): ApiJson<MarkReadRequest>,
) -> Result<Response, MessageError> {
    let Path((_, channel, topic)) = path.map_err(|_| MessageError::InvalidInput)?;
    mark(&state, &auth, channel, Some(topic), input).await
}

async fn mark(
    state: &AppState,
    auth: &Auth,
    channel: Uuid,
    topic: Option<Uuid>,
    input: MarkReadRequest,
) -> Result<Response, MessageError> {
    if input.read_seq < 0 {
        return Err(MessageError::InvalidInput);
    }
    tokio::time::timeout(
        admission::WORK_TIMEOUT,
        mark_inner(state, auth, channel, topic, input),
    )
    .await
    .map_err(|_| MessageError::Database(sqlx::Error::Io(std::io::ErrorKind::TimedOut.into())))?
}

async fn mark_inner(
    state: &AppState,
    auth: &Auth,
    channel: Uuid,
    topic: Option<Uuid>,
    input: MarkReadRequest,
) -> Result<Response, MessageError> {
    let organization = auth.identity.organization.organization_id;
    let member = (auth.identity.member.id, auth.membership_revision);
    require_visible(&state.pool, organization, member, channel).await?;
    let w = topics::watermark(state, organization, channel).await?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("SET LOCAL lock_timeout = '5s'")
        .execute(&mut *tx)
        .await?;
    match channels::is_visible_for_write(&mut tx, organization, member, channel).await? {
        None => return Err(MessageError::OrganizationUnavailable),
        Some(false) => return Err(MessageError::NotFound),
        Some(true) => {}
    }
    // Serialize all positions with revocation's cascading delete/reset. A grant
    // lost while waiting must be checked again in a fresh statement snapshot.
    let initial: i64 = sqlx::query_scalar("SELECT initial_seq FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 AND membership_revision=$4 FOR UPDATE")
        .bind(organization).bind(channel).bind(member.0).bind(member.1).fetch_optional(&mut *tx).await?.ok_or(MessageError::NotFound)?;
    require_visible(&mut *tx, organization, member, channel).await?;
    let requested = input.read_seq.min(w).max(initial);
    let read_seq = if let Some(topic) = topic {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM topics WHERE organization_id=$1 AND channel_id=$2 AND id=$3)")
            .bind(organization).bind(channel).bind(topic).fetch_one(&mut *tx).await?;
        if !exists {
            return Err(MessageError::TopicNotFound);
        }
        sqlx::query_scalar("INSERT INTO topic_read_positions (organization_id,channel_id,member_id,topic_id,read_seq) VALUES ($1,$2,$3,$4,$5) \
            ON CONFLICT (organization_id,channel_id,member_id,topic_id) DO UPDATE SET read_seq=GREATEST(topic_read_positions.read_seq,EXCLUDED.read_seq) RETURNING read_seq")
            .bind(organization).bind(channel).bind(member.0).bind(topic).bind(requested).fetch_one(&mut *tx).await?
    } else {
        sqlx::query_scalar("UPDATE channel_read_positions SET read_seq=GREATEST(read_seq,$4) WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 RETURNING read_seq")
            .bind(organization).bind(channel).bind(member.0).bind(requested).fetch_one(&mut *tx).await?
    };
    tx.commit().await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(ReadPosition { read_seq }),
    )
        .into_response())
}
