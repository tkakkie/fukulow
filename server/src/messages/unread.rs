use super::*;
use sqlx::Row;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct UnreadChannel {
    pub history_generation: Uuid,
    #[serde(flatten)]
    pub channel: channels::Channel,
    /// Latest committed Channel seq in the positions/counts snapshot; 0 if empty.
    pub as_of_seq: i64,
    /// Current Member position for Messages without Topic; independent of as_of_seq.
    pub read_seq: i64,
    /// Other senders' Messages without Topic above read_seq, bounded by as_of_seq.
    pub main_unread_count: i64,
    /// Channel badge: main-timeline Unread plus all Topic Unread, bounded by as_of_seq.
    pub unread_count: i64,
    #[schema(minimum = 0)]
    pub main_mention_unread_count: i64,
    #[schema(minimum = 0)]
    pub mention_unread_count: i64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ChannelList {
    pub history_generation: Uuid,
    pub channels: Vec<UnreadChannel>,
}

#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ChannelListQuery {
    pub history_generation: Option<Uuid>,
    /// Return archived Channels when true. The default lists active Channels.
    pub archived: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MarkReadRequest {
    pub history_generation: Option<Uuid>,
    /// Monotonic max, clamped to the latest committed Channel seq. Sending never marks read.
    #[schema(minimum = 0)]
    pub read_seq: i64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ReadPosition {
    pub history_generation: Uuid,
    pub read_seq: i64,
}

// #519 A3: no count reads `messages`. Per scope, Unread in (read_seq, S] is
// (appended - own appended) - (read_ordinal - read_own_ordinal) + other senders'
// corrections in the range (migration 202611221100 has the identity). Mentions
// are a range on the counted partial index. The counter and the counts commit
// atomically, so this snapshot's counts are exactly bounded by its counter.
// A Topic with last_seq at or below its position has no live Message above it;
// a missing Topic position is ordinals 0 at initial_seq. Each scope is clamped at
// 0 and count_drift reports a negative raw value, which the identity rules out.
// Materialize the Member's unread Topic candidates once, rather than rescan
// every Topic under RLS per Channel. Carry the lower bound as a column: PostgreSQL
// does not recognise COALESCE as leakproof, so it stays out of RLS index quals.
pub(super) const LIST_COUNTS_SQL: &str = r#"
WITH unread_topics AS MATERIALIZED (
    SELECT t.organization_id, t.channel_id, t.id, t.last_seq,
        COALESCE(tr.read_seq, p.initial_seq) AS read_seq,
        COALESCE(tr.read_ordinal, 0) AS read_ordinal,
        COALESCE(tr.read_own_ordinal, 0) AS read_own_ordinal
    FROM topics t
    JOIN channel_read_positions p ON p.organization_id = $1 AND p.member_id = $2
        AND p.membership_revision = $3 AND p.channel_id = t.channel_id
    LEFT JOIN topic_read_positions tr ON tr.organization_id = $1 AND tr.channel_id = t.channel_id
        AND tr.member_id = $2 AND tr.topic_id = t.id
    WHERE t.organization_id = $1 AND t.channel_id = ANY($4)
        AND t.last_seq > COALESCE(tr.read_seq, p.initial_seq)
)
SELECT c.channel_id, COALESCE(s.seq, 0) AS as_of_seq,
    COALESCE(p.read_seq, s.seq, 0) AS read_seq,
    p.channel_id IS NULL AS missing_position,
    GREATEST(main.unread_count, 0) AS main_unread_count,
    GREATEST(main.unread_count, 0) + topic.unread_count AS unread_count,
    main.mention_unread_count AS main_mention_unread_count,
    main.mention_unread_count + topic.mention_unread_count AS mention_unread_count,
    main.unread_count < 0 OR topic.drift AS count_drift
FROM unnest($4::uuid[]) c(channel_id)
LEFT JOIN channel_read_positions p ON p.organization_id = $1 AND p.member_id = $2
    AND p.membership_revision = $3 AND p.channel_id = c.channel_id
LEFT JOIN channel_message_sequences s ON s.organization_id = $1 AND s.channel_id = c.channel_id
CROSS JOIN LATERAL (
    SELECT CASE WHEN p.channel_id IS NULL OR COALESCE(s.seq, 0) <= p.read_seq THEN 0 ELSE
        (SELECT (COALESCE(sum(k.appended) FILTER (WHERE k.member_id = '00000000-0000-0000-0000-000000000000'), 0)
              - COALESCE(sum(k.appended) FILTER (WHERE k.member_id = $2), 0))::bigint
         FROM message_append_counts k WHERE k.organization_id = $1 AND k.channel_id = c.channel_id
            AND k.scope_id = '00000000-0000-0000-0000-000000000000'
            AND k.member_id IN ('00000000-0000-0000-0000-000000000000', $2))
        - p.read_ordinal + p.read_own_ordinal
        + (SELECT COALESCE(sum(x.delta), 0) FROM message_count_corrections x
           WHERE x.organization_id = $1 AND x.channel_id = c.channel_id
             AND x.scope_id = '00000000-0000-0000-0000-000000000000'
             AND x.seq > p.read_seq AND x.seq <= s.seq AND x.sender <> $2)
    END AS unread_count,
    CASE WHEN p.channel_id IS NULL OR COALESCE(s.seq, 0) <= p.read_seq THEN 0 ELSE
        (SELECT count(*) FROM message_mentions mm
         WHERE mm.organization_id = $1 AND mm.member_id = $2 AND mm.channel_id = c.channel_id
           AND mm.topic_id IS NULL AND mm.seq > p.read_seq AND mm.seq <= s.seq AND mm.counted)
    END AS mention_unread_count
    OFFSET 0
) main
CROSS JOIN LATERAL (
    SELECT COALESCE(sum(GREATEST(tc.unread_count, 0)), 0)::bigint AS unread_count,
        COALESCE(sum(tc.mention_unread_count), 0)::bigint AS mention_unread_count,
        COALESCE(bool_or(tc.unread_count < 0), false) AS drift
    FROM unread_topics t
    CROSS JOIN LATERAL (
        SELECT
            (SELECT (COALESCE(sum(k.appended) FILTER (WHERE k.member_id = '00000000-0000-0000-0000-000000000000'), 0)
                  - COALESCE(sum(k.appended) FILTER (WHERE k.member_id = $2), 0))::bigint
             FROM message_append_counts k WHERE k.organization_id = $1 AND k.channel_id = c.channel_id
                AND k.scope_id = t.id AND k.member_id IN ('00000000-0000-0000-0000-000000000000', $2))
            - t.read_ordinal + t.read_own_ordinal
            + (SELECT COALESCE(sum(x.delta), 0) FROM message_count_corrections x
               WHERE x.organization_id = $1 AND x.channel_id = c.channel_id AND x.scope_id = t.id
                 AND x.seq > t.read_seq AND x.seq <= s.seq AND x.sender <> $2)
            AS unread_count,
            (SELECT count(*) FROM message_mentions mm
             WHERE mm.organization_id = $1 AND mm.member_id = $2 AND mm.channel_id = c.channel_id
               AND mm.topic_id = t.id AND mm.seq > t.read_seq AND mm.seq <= s.seq AND mm.counted)
            AS mention_unread_count
        OFFSET 0
    ) tc
    WHERE p.channel_id IS NOT NULL AND t.organization_id = $1 AND t.channel_id = c.channel_id
        AND COALESCE(s.seq, 0) > t.read_seq
) topic
"#;

/// List visible Channels with the current Member's read positions and Unread counts.
///
/// Public Channels require a non-Guest Role or a current grant; private Channels require a current grant.
#[utoipa::path(get, path = "/api/v1/orgs/{org}/channels",
    params(("org" = Uuid, Path, description = "Organization id"), ChannelListQuery),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Visible Channels with current Member positions and Unread counts; refetch on reconnect", body = ChannelList),
        (status = 400, description = "Malformed Organization id or invalid query input", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 409, description = "history_generation_changed for a stale Organization epoch", body = crate::auth::ErrorBody),
        (status = 404, description = "Non-Member, unknown Organization or deactivated Member: organization_unavailable", body = ErrorBody),
        (status = 500, description = "Database failure while listing visible Channels and Unread", body = ErrorBody)))]
pub async fn list_channels(
    State(state): State<AppState>,
    auth: Auth,
    query: Result<Query<ChannelListQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let Query(query) =
        query.map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid input", None))?;
    crate::database::organization_read_only(
        &state.pool,
        auth.identity.organization.organization_id,
        async |tx: &mut sqlx::PgConnection| {
            let channels =
                channels::visible_list(&mut *tx, &auth, Some(query.archived.unwrap_or(false)))
                    .await?;
            #[cfg(test)]
            tests::unread::baseline::pause_list(auth.identity.member.id).await;
            let history_generation = crate::auth::history::validate(
                tx,
                auth.identity.organization.organization_id,
                query.history_generation,
            )
            .await?;
            let ids = channels.iter().map(|c| c.id).collect::<Vec<_>>();
            // Two batched queries in one authorization/data snapshot, independent of the
            // number of Channels or Topics. No Message or position outside ids is read.
            let rows = sqlx::query(LIST_COUNTS_SQL)
                .bind(auth.identity.organization.organization_id)
                .bind(auth.identity.member.id)
                .bind(auth.membership_revision)
                .bind(&ids)
                .fetch_all(&mut *tx)
                .await?;
            let mut counts = std::collections::HashMap::new();
            for row in rows {
                if row.try_get::<bool, _>("missing_position")? {
                    tracing::error!(target: "fukulow", event = "missing_unread_position");
                }
                if row.try_get::<bool, _>("count_drift")? {
                    tracing::error!(target: "fukulow", event = "unread_count_drift");
                }
                counts.insert(
                    row.try_get::<Uuid, _>("channel_id")?,
                    (
                        row.try_get::<i64, _>("as_of_seq")?,
                        row.try_get::<i64, _>("read_seq")?,
                        row.try_get::<i64, _>("main_unread_count")?,
                        row.try_get::<i64, _>("unread_count")?,
                        row.try_get::<i64, _>("main_mention_unread_count")?,
                        row.try_get::<i64, _>("mention_unread_count")?,
                    ),
                );
            }
            let mut result = Vec::with_capacity(channels.len());
            for channel in channels {
                let (
                    as_of_seq,
                    read_seq,
                    main_unread_count,
                    unread_count,
                    main_mention_unread_count,
                    mention_unread_count,
                ) = counts.remove(&channel.id).ok_or(sqlx::Error::RowNotFound)?;
                result.push(UnreadChannel {
                    channel,
                    history_generation,
                    as_of_seq,
                    read_seq,
                    main_unread_count,
                    unread_count,
                    main_mention_unread_count,
                    mention_unread_count,
                });
            }
            Ok((
                [(header::CACHE_CONTROL, "no-store")],
                Json(ChannelList {
                    history_generation,
                    channels: result,
                }),
            )
                .into_response())
        },
    )
    .await
}

#[utoipa::path(put, path = "/api/v1/orgs/{org}/channels/{id}/read", request_body = MarkReadRequest,
    params(("org" = Uuid, Path), ("id" = Uuid, Path)),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Monotonic Channel position for Messages without Topic only", body = ReadPosition),
        (status = 400, description = "Invalid ids, negative read_seq or malformed JSON; Topic read in an accessible DM refuses dm_topics_not_allowed", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 409, description = "history_generation_changed for a stale Organization epoch", body = crate::auth::ErrorBody),
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
        (status = 409, description = "history_generation_changed for a stale Organization epoch", body = crate::auth::ErrorBody),
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
    require_visible_scoped(&state.pool, organization, member, channel).await?;
    if topic.is_some() {
        reject_dm_topics_scoped(state, auth, channel).await?;
    }
    let w = topics::watermark(state, organization, channel).await?;
    let state = state.clone();
    let (read_seq, history_generation) = tokio::spawn(async move {
    let (read_seq, changed, history_generation) = crate::database::organization(&state.pool, organization, async |tx: &mut sqlx::PgConnection| {
        sqlx::query("SET LOCAL lock_timeout = '5s'")
            .execute(&mut *tx)
            .await?;
        match channels::is_visible_for_write(&mut *tx, organization, member, channel).await? {
            None => return Err(MessageError::OrganizationUnavailable),
            Some(false) => return Err(MessageError::NotFound),
            Some(true) => {}
        }
        let history_generation = history::validate(tx, organization, channel, input.history_generation, None).await?;
        #[cfg(test)]
        tests::removal::pause(member.0).await;
        // Serialize positions with revocation's cascading delete/reset. If access
        // is lost while waiting, the deleted position itself makes this return 404.
        if topic.is_some() {reject_dm_topics(tx,organization,channel).await?;}
        let initial: i64 = sqlx::query_scalar("SELECT initial_seq FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 AND membership_revision=$4 FOR UPDATE")
            .bind(organization).bind(channel).bind(member.0).bind(member.1).fetch_optional(&mut *tx).await?.ok_or(MessageError::NotFound)?;
        let requested = input.read_seq.min(w).max(initial);
        let previous: i64 = if let Some(topic) = topic {
            sqlx::query_scalar("SELECT read_seq FROM topic_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 AND topic_id=$4").bind(organization).bind(channel).bind(member.0).bind(topic).fetch_optional(&mut *tx).await?.unwrap_or(initial)
        } else {
            sqlx::query_scalar("SELECT read_seq FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(organization).bind(channel).bind(member.0).fetch_one(&mut *tx).await?
        };
        let read_seq = if let Some(topic) = topic {
            let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM topics WHERE organization_id=$1 AND channel_id=$2 AND id=$3)")
                .bind(organization).bind(channel).bind(topic).fetch_one(&mut *tx).await?;
            if !exists {
                return Err(MessageError::TopicNotFound);
            }
            // Update first: an upsert would also run the BEFORE INSERT ordinal trigger
            // for the proposed row. Rows are created on access, so the insert is rare.
            let updated: Option<i64> = sqlx::query_scalar("UPDATE topic_read_positions SET read_seq=GREATEST(read_seq,$5) WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 AND topic_id=$4 RETURNING read_seq")
                .bind(organization).bind(channel).bind(member.0).bind(topic).bind(requested).fetch_optional(&mut *tx).await?;
            match updated {
                Some(read_seq) => read_seq,
                None => sqlx::query_scalar("INSERT INTO topic_read_positions (organization_id,channel_id,member_id,topic_id,read_seq) VALUES ($1,$2,$3,$4,$5) \
                    ON CONFLICT (organization_id,channel_id,member_id,topic_id) DO UPDATE SET read_seq=GREATEST(topic_read_positions.read_seq,EXCLUDED.read_seq) RETURNING read_seq")
                    .bind(organization).bind(channel).bind(member.0).bind(topic).bind(requested).fetch_one(&mut *tx).await?,
            }
        } else {
            sqlx::query_scalar("UPDATE channel_read_positions SET read_seq=GREATEST(read_seq,$4) WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 RETURNING read_seq")
                .bind(organization).bind(channel).bind(member.0).bind(requested).fetch_one(&mut *tx).await?
        };
        Ok::<_, MessageError>((read_seq, read_seq > previous, history_generation))
    }).await?;
    if changed { state.message_delivery.channel_access.activity.spawn(state.pool.clone(), organization, channels::activity::Notice::ReadPositionChanged { channel_id: channel, topic_id: topic, read_seq }, Some(member.0)); }
    Ok::<_, MessageError>((read_seq, history_generation))
    }).await.map_err(|_| MessageError::Database(sqlx::Error::WorkerCrashed))??;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(ReadPosition {
            read_seq,
            history_generation,
        }),
    )
        .into_response())
}
