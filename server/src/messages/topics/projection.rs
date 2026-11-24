use super::*;
use sqlx::Row;

#[cfg(test)]
mod measurement;
#[cfg(test)]
pub(in crate::messages) mod reference;

// At W >= the mutation floor, only Creates followed W. Topic summaries can
// therefore be rewound by removing their live suffix. Find each Topic's last
// position at W before applying the exclusive page boundary.
// Bound both ends of the active Topic range so a Generic plan can index it.
// The main range uses the NULL Topic key, which includes tombstones.
pub(in crate::messages) fn page_sql() -> String {
    page_sql_in_direction(false)
}

fn page_sql_in_direction(newer: bool) -> String {
    let order = if newer { "ASC" } else { "DESC" };
    let range = |position: &str, bigint: &str| {
        if newer {
            format!("{position} > $6{bigint} AND {position} <= $5{bigint}")
        } else {
            format!("{position} <= LEAST($5{bigint}, $6{bigint} - 1)")
        }
    };
    let sql = format!(
        r#"
WITH access AS MATERIALIZED (SELECT ({}) AS visible),
channel_counter AS MATERIALIZED (
    SELECT seq FROM channel_message_sequences WHERE organization_id = $1 AND channel_id = $4
        AND (SELECT visible FROM access)
),
unchanged_topics AS (
    SELECT t.id AS topic_id, t.first_seq, t.last_seq, t.last_seq AS current_last_seq, t.message_count, t.name
    FROM topics t
    WHERE t.organization_id = $1 AND t.channel_id = $4 AND $9::uuid IS NULL
        AND {unchanged_range}
        AND (SELECT visible FROM access)
    ORDER BY t.last_seq {order} LIMIT $7
),
topics_to_position AS (
    SELECT t.id, t.first_seq, t.last_seq, t.message_count, t.name
    FROM topics t
    WHERE t.organization_id = $1 AND t.channel_id = $4 AND $9 IS NULL
        AND t.last_seq > $5 AND t.last_seq <= (SELECT seq FROM channel_counter)
        AND t.first_seq <= $5 AND (SELECT visible FROM access)
    UNION ALL
    SELECT t.id, t.first_seq, t.last_seq, t.message_count, t.name
    FROM topics t
    WHERE t.organization_id = $1 AND t.channel_id = $4 AND t.id = $9
        AND t.first_seq <= $5 AND (SELECT visible FROM access)
),
positioned_topics AS (
    SELECT t.id AS topic_id, t.first_seq,
        CASE WHEN t.last_seq <= $5 THEN t.last_seq ELSE (
            SELECT m.seq FROM messages m
            WHERE m.organization_id = $1 AND m.channel_id = $4 AND m.topic_id = t.id
                AND NOT m.deleted AND m.seq <= $5
            ORDER BY m.seq DESC LIMIT 1
        ) END AS last_seq,
        t.last_seq AS current_last_seq, t.message_count, t.name
    FROM topics_to_position t
    OFFSET 0
),
main_messages AS (
    SELECT m.topic_id, m.seq AS first_seq, m.seq AS last_seq,
        m.seq AS current_last_seq, 1::bigint AS message_count, NULL::text AS name
    FROM messages m
    WHERE m.organization_id = $1 AND m.channel_id = $4 AND m.topic_id IS NULL
        AND {main_range}
        AND NOT $8 AND $9 IS NULL AND (SELECT visible FROM access)
    ORDER BY m.seq {order} LIMIT $7
),
candidates AS (
    SELECT * FROM unchanged_topics
    UNION ALL
    SELECT * FROM positioned_topics WHERE {positioned_range}
    UNION ALL
    SELECT * FROM main_messages
),
page AS (
    SELECT * FROM candidates ORDER BY last_seq {order} LIMIT $7
),
page_positions AS MATERIALIZED (
    SELECT p.*,
        CASE WHEN p.topic_id IS NULL THEN 0 ELSE COALESCE(tr.read_seq, cr.initial_seq, $5) END AS read_seq,
        COALESCE(tr.read_ordinal, 0) AS read_ordinal,
        COALESCE(tr.read_own_ordinal, 0) AS read_own_ordinal
    FROM page p
    LEFT JOIN channel_read_positions cr ON cr.organization_id = $1 AND cr.channel_id = $4
        AND cr.member_id = $2 AND cr.membership_revision = $3 AND p.topic_id IS NOT NULL
    LEFT JOIN LATERAL (
        SELECT tr.read_seq, tr.read_ordinal, tr.read_own_ordinal
        FROM topic_read_positions tr WHERE tr.organization_id = $1 AND tr.channel_id = $4
            AND tr.member_id = $2 AND tr.topic_id = p.topic_id AND cr.channel_id IS NOT NULL
        OFFSET 0
    ) tr ON true
)
SELECT access.visible, $5 AS as_of_seq, p.first_seq, p.last_seq,
    p.message_count - tail.message_count AS message_count, p.read_seq,
    CASE WHEN p.last_seq IS NOT NULL THEN GREATEST(uc.unread_count, 0) END AS unread_count,
    uc.unread_count < 0 AS count_drift, mc.mention_unread_count, p.name,
    m.id, m.channel_id, m.seq, m.version, m.deleted, m.client_message_id,
    m.sender, m.body, m.topic_id, m.reply_to_id AS reply_to, m.reply_root_id,
    to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM access LEFT JOIN page_positions p ON true
CROSS JOIN LATERAL (
    SELECT count(*) AS message_count, count(*) FILTER (WHERE m.sender <> $2) AS unread_count
    FROM messages m
    WHERE p.current_last_seq > $5 AND m.organization_id = $1 AND m.channel_id = $4
        AND m.topic_id = p.topic_id AND NOT m.deleted AND m.seq > $5 AND m.seq <= p.current_last_seq
) tail
-- When p.last_seq > read_seq, every live Message above W is also above read_seq.
-- The #519 A3 identity at the snapshot counter can then subtract that entire suffix.
CROSS JOIN LATERAL (
    SELECT CASE WHEN p.topic_id IS NULL OR p.last_seq <= p.read_seq THEN 0 ELSE
        (SELECT (COALESCE(sum(k.appended) FILTER (WHERE k.member_id = '00000000-0000-0000-0000-000000000000'), 0)
              - COALESCE(sum(k.appended) FILTER (WHERE k.member_id = $2), 0))::bigint
         FROM message_append_counts k WHERE k.organization_id = $1 AND k.channel_id = $4
            AND k.scope_id = p.topic_id AND k.member_id IN ('00000000-0000-0000-0000-000000000000', $2))
        - p.read_ordinal + p.read_own_ordinal
        + (SELECT COALESCE(sum(x.delta), 0) FROM message_count_corrections x
           WHERE x.organization_id = $1 AND x.channel_id = $4 AND x.scope_id = p.topic_id
             AND x.seq > p.read_seq AND x.seq <= (SELECT seq FROM channel_counter) AND x.sender <> $2)
        - tail.unread_count
    END AS unread_count
    OFFSET 0
) uc
CROSS JOIN LATERAL (
    SELECT count(*) AS mention_unread_count
    FROM message_mentions mm
    WHERE mm.organization_id = $1 AND mm.member_id = $2 AND mm.channel_id = $4
        AND mm.topic_id = p.topic_id AND mm.seq > p.read_seq AND mm.seq <= $5 AND mm.counted
) mc
LEFT JOIN LATERAL (
    SELECT * FROM messages m WHERE m.organization_id = $1 AND m.channel_id = $4 AND m.seq = p.last_seq
    OFFSET 0
) m ON true
ORDER BY p.last_seq {order}
"#,
        channels::member_visibility_sql(false),
        unchanged_range = range("t.last_seq", "::bigint"),
        main_range = range("m.seq", ""),
        positioned_range = range("last_seq", ""),
    );
    mentions::page_sql(&sql, &format!("p.last_seq {order}"))
}

struct Projection {
    history_generation: Uuid,
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
    let newer = query.after_position.is_some();
    let organization = auth.identity.organization.organization_id;
    // Cheap denial before watermark admission; reauthorize in the page snapshot.
    require_visible_scoped(
        &state.pool,
        organization,
        (auth.identity.member.id, auth.membership_revision),
        channel,
    )
    .await?;
    if topics_only || topic.is_some() {
        reject_dm_topics_scoped(state, auth, channel).await?;
    }
    tokio::time::timeout(admission::WORK_TIMEOUT, async {
        super::watermark(state, organization, channel).await?;
        // Admission resolves prior ambiguous commits; W is selected in the page snapshot.
        let (history_generation, rows) = crate::database::organization_read_only(
            &state.pool,
            organization,
            async |tx: &mut sqlx::PgConnection| {
                require_visible(
                    &mut *tx,
                    organization,
                    (auth.identity.member.id, auth.membership_revision),
                    channel,
                )
                .await?;
                let (history_generation, w) = history::page(
                    tx,
                    organization,
                    channel,
                    query.history_generation,
                    query.as_of_seq,
                )
                .await?;
                let sql = if newer {
                    page_sql_in_direction(true)
                } else {
                    page_sql()
                };
                let rows = sqlx::query(&sql)
                    // Repeated reads otherwise select a much slower generic plan (#326).
                    .persistent(false)
                    .bind(organization)
                    .bind(auth.identity.member.id)
                    .bind(auth.membership_revision)
                    .bind(channel)
                    .bind(w)
                    .bind(query.after_position.or(query.before_position))
                    .bind(i64::from(limit) + 1)
                    .bind(topics_only)
                    .bind(topic)
                    .fetch_all(tx)
                    .await?;
                Ok::<_, MessageError>((history_generation, rows))
            },
        )
        .await?;
        let first = rows.first().ok_or(sqlx::Error::RowNotFound)?;
        match first.try_get::<Option<bool>, _>("visible")? {
            None => return Err(MessageError::OrganizationUnavailable),
            Some(false) => return Err(MessageError::NotFound),
            Some(true) => {}
        }
        let w: i64 = first.try_get("as_of_seq")?;
        let mut items = Vec::new();
        for row in &rows {
            if row.try_get::<Option<Uuid>, _>("id")?.is_none() {
                continue;
            }
            if row.try_get::<bool, _>("count_drift")? {
                tracing::error!(target: "fukulow", event = "unread_count_drift");
            }
            let message = message_from_row(row)?;
            items.push(match message.topic_id {
                None => TimelineItem::Message { message },
                Some(id) => TimelineItem::Topic {
                    topic: TopicSummary {
                        id,
                        name: row.try_get("name")?,
                        first_seq: row.try_get("first_seq")?,
                        last_seq: row.try_get("last_seq")?,
                        message_count: row.try_get("message_count")?,
                        read_seq: row.try_get("read_seq")?,
                        unread_count: row.try_get("unread_count")?,
                        mention_unread_count: row.try_get("mention_unread_count")?,
                        latest_message: message,
                    },
                },
            });
        }
        let has_more = items.len() > usize::from(limit);
        items.truncate(usize::from(limit));
        if !newer {
            items.reverse();
        }
        Ok(Projection {
            history_generation,
            w,
            items,
            has_more,
        })
    })
    .await
    .map_err(|_| MessageError::Database(sqlx::Error::Io(std::io::ErrorKind::TimedOut.into())))?
}

/// Main timeline projection at a fixed W. Topic Messages are represented once by their summary.
#[utoipa::path(get, path = "/api/v1/orgs/{org}/channels/{id}/timeline",
    params(("org" = Uuid, Path), ("id" = Uuid, Path), ListProjectionQuery),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Ascending W-relative positions; initial page fixes W. Continue exclusively with as_of_seq and before_position (older) or after_position (newer); has_more follows the requested direction, older on the initial page; cursor-neutral", body = TimelinePage),
        (status = 400, description = "Invalid Organization id, Channel id, negative/future W, boundary without W, conflicting boundaries, before_position below 1, after_position below 0 or limit outside 1..=200", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 409, description = "history_generation_changed for a stale Organization epoch; snapshot_expired for a fixed watermark below the Channel mutation floor; no partial page", body = crate::auth::ErrorBody),
        (status = 404, description = "organization_unavailable or channel not found; private and unknown Channels are identical", body = ErrorBody),
        (status = 503, description = "Projection watermark admission unavailable; Retry-After gives retry seconds", body = ErrorBody,
            headers(("Retry-After" = inline(crate::auth::RetryAfterSeconds), description = "Jittered retry delay in seconds (1 through 5)"))),
        (status = 500, description = "Database failure or commit barrier timeout reading the projection", body = ErrorBody)))]
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
            history_generation: p.history_generation,
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
    responses((status = 200, description = "Ascending W-relative Topic summaries; initial page fixes W. Continue exclusively with as_of_seq and before_position (older) or after_position (newer); has_more follows the requested direction, older on the initial page; cursor-neutral", body = TopicPage),
        (status = 400, description = "Invalid Organization id, Channel id, negative/future W, boundary without W, conflicting boundaries, before_position below 1, after_position below 0, limit outside 1..=200, or Topics in a DM", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 409, description = "history_generation_changed for a stale Organization epoch; snapshot_expired for a fixed watermark below the Channel mutation floor; no partial page", body = crate::auth::ErrorBody),
        (status = 404, description = "organization_unavailable or channel not found", body = ErrorBody),
        (status = 503, description = "Projection watermark admission unavailable; Retry-After gives retry seconds", body = ErrorBody,
            headers(("Retry-After" = inline(crate::auth::RetryAfterSeconds), description = "Jittered retry delay in seconds (1 through 5)"))),
        (status = 500, description = "Database failure or barrier timeout listing Topics", body = ErrorBody)))]
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
            history_generation: p.history_generation,
            as_of_seq: p.w,
            topics,
            has_more: p.has_more,
        }),
    )
        .into_response())
}

/// Current bounded baseline for a Topic first encountered through live delivery.
#[utoipa::path(get, path = "/api/v1/orgs/{org}/channels/{id}/topics/{topic_id}",
    params(("org" = Uuid, Path), ("id" = Uuid, Path), ("topic_id" = Uuid, Path), fukulow_api::HistoryQuery),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "One absolute Topic baseline as of a barrier-protected W; cursor-neutral", body = TopicSummaryResponse),
        (status = 400, description = "Invalid Organization id, Channel id or Topic id", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 409, description = "history_generation_changed for a stale Organization epoch; snapshot_expired for a fixed watermark below the Channel mutation floor; no partial page", body = crate::auth::ErrorBody),
        (status = 404, description = "organization_unavailable, channel not found or topic_not_found; unknown and foreign Topics are identical", body = ErrorBody),
        (status = 503, description = "Projection watermark admission unavailable; Retry-After gives retry seconds", body = ErrorBody,
            headers(("Retry-After" = inline(crate::auth::RetryAfterSeconds), description = "Jittered retry delay in seconds (1 through 5)"))),
        (status = 500, description = "Database failure or barrier timeout reading the Topic summary", body = ErrorBody)))]
pub async fn topic_summary(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid, Uuid)>, PathRejection>,
    query: Result<Query<fukulow_api::HistoryQuery>, QueryRejection>,
) -> Result<Response, MessageError> {
    let Path((_, channel, topic)) = path.map_err(|_| MessageError::InvalidInput)?;
    let Query(query) = query.map_err(|_| MessageError::InvalidInput)?;
    let p = read(
        &state,
        &auth,
        channel,
        ListProjectionQuery {
            history_generation: query.history_generation,
            as_of_seq: None,
            before_position: None,
            after_position: None,
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
            history_generation: p.history_generation,
            as_of_seq: p.w,
            topic,
        }),
    )
        .into_response())
}
