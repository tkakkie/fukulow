use super::*;
use sqlx::{FromRow, Row};

// Reconstruct every Topic's position BEFORE the exclusive boundary. Current
// topics.last_seq cannot enumerate Topics that moved after W. Counts use the same
// immutable prefix. Only selected candidates fetch payloads (no per-Topic SQL).
fn page_sql() -> String {
    format!(
        r#"
WITH access AS MATERIALIZED (SELECT ({}) AS visible),
anchor AS MATERIALIZED (
    SELECT COALESCE((SELECT seq FROM channel_message_sequences
        WHERE organization_id = $1 AND channel_id = $4), 0) AS committed_seq
),
w AS MATERIALIZED (SELECT committed_seq, COALESCE($5, committed_seq) AS as_of_seq FROM anchor),
positions AS (
    SELECT topic_id, min(seq) AS first_seq, max(seq) AS last_seq, count(*) AS message_count
    FROM messages, w, access
    WHERE organization_id = $1 AND channel_id = $4 AND topic_id IS NOT NULL
        AND seq <= w.as_of_seq AND access.visible AND ($9::uuid IS NULL OR topic_id = $9)
    GROUP BY topic_id
),
candidates AS (
    SELECT * FROM positions
    UNION ALL
    SELECT topic_id, seq, seq, 1::bigint FROM messages, w, access
    WHERE organization_id = $1 AND channel_id = $4 AND topic_id IS NULL
        AND seq <= w.as_of_seq AND access.visible AND NOT $8 AND $9::uuid IS NULL
),
page AS MATERIALIZED (
    SELECT * FROM candidates WHERE ($6::bigint IS NULL OR last_seq < $6)
    ORDER BY last_seq DESC LIMIT $7
)
SELECT access.visible, w.committed_seq, w.as_of_seq, p.first_seq, p.last_seq,
    p.message_count, t.name, m.id, m.channel_id, m.seq, m.client_message_id,
    m.sender, m.body, m.topic_id,
    to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM access CROSS JOIN w LEFT JOIN page p ON true
LEFT JOIN messages m ON m.organization_id = $1 AND m.channel_id = $4 AND m.seq = p.last_seq
LEFT JOIN topics t ON t.organization_id = $1 AND t.channel_id = $4 AND t.id = p.topic_id
ORDER BY p.last_seq DESC
"#,
        channels::member_visibility_sql(false)
    )
}

struct Projection {
    w: i64,
    items: Vec<TimelineItem>,
    has_more: bool,
}

async fn read(
    state: &AppState,
    auth: &Auth,
    channel: Uuid,
    query: ListProjectionQuery,
    topics_only: bool,
    topic: Option<Uuid>,
) -> Result<Projection, MessageError> {
    let limit = query.validate()?;
    let organization = auth.identity.organization.organization_id;
    // Cheap denial before watermark admission; reauthorize in the page snapshot.
    require_visible(
        &state.pool,
        organization,
        (auth.identity.member.id, auth.membership_revision),
        channel,
    )
    .await?;
    tokio::time::timeout(admission::WORK_TIMEOUT, async {
        let permit = state
            .message_delivery
            .admission(&state.pool)
            .acquire(organization, channel, false)
            .await?;
        let mut tx =
            commit::Transaction::begin(&state.pool, permit, "BEGIN ISOLATION LEVEL READ COMMITTED")
                .await?;
        commit::lock(tx.connection()?, organization, channel, true).await?;
        // The next statement gets a fresh snapshot AFTER the barrier. Authorization,
        // W, positions, counts and latest payloads all belong to that one snapshot.
        let rows = sqlx::query(&page_sql())
            .bind(organization)
            .bind(auth.identity.member.id)
            .bind(auth.membership_revision)
            .bind(channel)
            .bind(query.as_of_seq)
            .bind(query.before_position)
            .bind(i64::from(limit) + 1)
            .bind(topics_only)
            .bind(topic)
            .fetch_all(tx.connection()?)
            .await?;
        tx.commit().await?;
        let first = rows.first().ok_or(sqlx::Error::RowNotFound)?;
        match first.try_get::<Option<bool>, _>("visible")? {
            None => return Err(MessageError::OrganizationUnavailable),
            Some(false) => return Err(MessageError::NotFound),
            Some(true) => {}
        }
        let w: i64 = first.try_get("as_of_seq")?;
        if w > first.try_get::<i64, _>("committed_seq")? {
            return Err(MessageError::InvalidInput);
        }
        let mut items = Vec::new();
        for row in &rows {
            if row.try_get::<Option<Uuid>, _>("id")?.is_none() {
                continue;
            }
            let message = Message::from_row(row)?;
            items.push(match message.topic_id {
                None => TimelineItem::Message { message },
                Some(id) => TimelineItem::Topic {
                    topic: TopicSummary {
                        id,
                        name: row.try_get("name")?,
                        first_seq: row.try_get("first_seq")?,
                        last_seq: row.try_get("last_seq")?,
                        message_count: row.try_get("message_count")?,
                        latest_message: message,
                    },
                },
            });
        }
        let has_more = items.len() > usize::from(limit);
        items.truncate(usize::from(limit));
        items.reverse();
        Ok(Projection { w, items, has_more })
    })
    .await
    .map_err(|_| MessageError::Database(sqlx::Error::Io(std::io::ErrorKind::TimedOut.into())))?
}

/// Main timeline projection at a fixed W. Topic Messages are represented once by their summary.
#[utoipa::path(get, path = "/api/v1/orgs/{org}/channels/{id}/timeline",
    params(("org" = Uuid, Path), ("id" = Uuid, Path), ListProjectionQuery),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Ascending W-relative positions; initial page fixes W, exclusive older continuation uses as_of_seq and before_position; cursor-neutral", body = TimelinePage),
        (status = 400, description = "Invalid Organization id, Channel id, negative/future W, boundary without W, nonpositive boundary or limit outside 1..=200", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 404, description = "organization_unavailable or channel not found; private and unknown Channels are identical", body = ErrorBody),
        (status = 500, description = "Database failure, admission or commit barrier timeout reading the projection", body = ErrorBody)))]
pub async fn list_timeline(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid)>, PathRejection>,
    query: Result<Query<ListProjectionQuery>, QueryRejection>,
) -> Result<Response, MessageError> {
    let Path((_, channel)) = path.map_err(|_| MessageError::InvalidInput)?;
    let Query(query) = query.map_err(|_| MessageError::InvalidInput)?;
    let p = read(&state, &auth, channel, query, false, None).await?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(TimelinePage {
            as_of_seq: p.w,
            items: p.items,
            has_more: p.has_more,
        }),
    )
        .into_response())
}

/// Topic summaries as of W, ordered by their W-relative latest activity.
#[utoipa::path(get, path = "/api/v1/orgs/{org}/channels/{id}/topics",
    params(("org" = Uuid, Path), ("id" = Uuid, Path), ListProjectionQuery),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "W-relative Topic summaries; default 50/max 200, ascending positions and exclusive older continuation; cursor-neutral", body = TopicPage),
        (status = 400, description = "Invalid Organization id, Channel id, negative/future W, boundary without W, nonpositive boundary or limit outside 1..=200", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 404, description = "organization_unavailable or channel not found", body = ErrorBody),
        (status = 500, description = "Database failure, admission or barrier timeout listing Topics", body = ErrorBody)))]
pub async fn list_topics(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid)>, PathRejection>,
    query: Result<Query<ListProjectionQuery>, QueryRejection>,
) -> Result<Response, MessageError> {
    let Path((_, channel)) = path.map_err(|_| MessageError::InvalidInput)?;
    let Query(query) = query.map_err(|_| MessageError::InvalidInput)?;
    let p = read(&state, &auth, channel, query, true, None).await?;
    let topics = p
        .items
        .into_iter()
        .filter_map(|i| match i {
            TimelineItem::Topic { topic } => Some(topic),
            _ => None,
        })
        .collect();
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(TopicPage {
            as_of_seq: p.w,
            topics,
            has_more: p.has_more,
        }),
    )
        .into_response())
}

/// Current bounded baseline for a Topic first encountered through live delivery.
#[utoipa::path(get, path = "/api/v1/orgs/{org}/channels/{id}/topics/{topic_id}",
    params(("org" = Uuid, Path), ("id" = Uuid, Path), ("topic_id" = Uuid, Path)),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "One absolute Topic baseline as of a barrier-protected W; cursor-neutral", body = TopicSummaryResponse),
        (status = 400, description = "Invalid Organization id, Channel id or Topic id", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 404, description = "organization_unavailable, channel not found or topic_not_found; unknown and foreign Topics are identical", body = ErrorBody),
        (status = 500, description = "Database failure, admission or barrier timeout reading the Topic summary", body = ErrorBody)))]
pub async fn topic_summary(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid, Uuid)>, PathRejection>,
) -> Result<Response, MessageError> {
    let Path((_, channel, topic)) = path.map_err(|_| MessageError::InvalidInput)?;
    let p = read(
        &state,
        &auth,
        channel,
        ListProjectionQuery {
            as_of_seq: None,
            before_position: None,
            limit: Some(1),
        },
        true,
        Some(topic),
    )
    .await?;
    let Some(TimelineItem::Topic { topic }) = p.items.into_iter().next() else {
        return Err(MessageError::TopicNotFound);
    };
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(TopicSummaryResponse {
            as_of_seq: p.w,
            topic,
        }),
    )
        .into_response())
}
