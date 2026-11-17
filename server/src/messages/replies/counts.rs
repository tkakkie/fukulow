use super::*;
use sqlx::Row;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ReplyCountRequest {
    /// Root or descendant ids. Limit applies before duplicate ids are merged.
    #[schema(min_items = 1, max_items = 100)]
    pub ids: Vec<Uuid>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ReplyCount {
    pub message_id: Uuid,
    pub root_id: Uuid,
    /// Exact number of live Replies in the entire chain, excluding the root.
    #[schema(minimum = 0)]
    pub reply_count: i64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ReplyCountPage {
    /// Committed Channel watermark W. Both anchors and Replies are bounded by W.
    /// This baseline is a projection and never advances a sync cursor or read position.
    #[schema(minimum = 0)]
    pub as_of_seq: i64,
    /// One entry per distinct requested id visible in this Channel at W, sorted by id.
    /// Unknown and foreign ids are omitted without distinction.
    pub counts: Vec<ReplyCount>,
}

// Aggregate once per distinct root, even when many requested children share it.
// Do not join/filter the root row: a future tombstone must retain its chain count.
pub(crate) const COUNTS_SQL: &str = "WITH anchors AS MATERIALIZED (\
    SELECT id AS message_id, COALESCE(reply_root_id,id) AS root_id FROM messages \
    WHERE organization_id=$1 AND channel_id=$2 AND id=ANY($3) AND seq<=$4\
    ), totals AS MATERIALIZED (\
    SELECT roots.root_id, c.reply_count FROM (SELECT DISTINCT root_id FROM anchors) roots \
    CROSS JOIN LATERAL (SELECT count(*) AS reply_count FROM messages \
        WHERE organization_id=$1 AND channel_id=$2 AND reply_root_id=roots.root_id AND seq<=$4) c\
    ) SELECT a.message_id,a.root_id,t.reply_count FROM anchors a \
    JOIN totals t USING (root_id) ORDER BY a.message_id";

#[utoipa::path(post, path = "/api/v1/orgs/{org}/channels/{id}/reply-counts", request_body = ReplyCountRequest,
    params(("org" = Uuid, Path, description = "Organization id"), ("id" = Uuid, Path, description = "Channel id")),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Exact chain counts at as_of_seq; unknown or foreign ids omitted; no-store, no side effects, cursor-neutral", body = ReplyCountPage),
        (status = 400, description = "Malformed ids or body, or input length outside 1..=100 before deduplication; validated before Organization/Channel authorization", body = ErrorBody),
        (status = 401, description = "Missing, invalid, expired, or revoked Account Session credential", body = ErrorBody),
        (status = 404, description = "organization_unavailable or channel not found; authorization denials precede watermark admission", body = ErrorBody),
        (status = 413, description = "Request too large", body = ErrorBody),
        (status = 415, description = "Expected application/json", body = ErrorBody),
        (status = 503, description = "Projection watermark admission unavailable", body = ErrorBody,
            headers(("Retry-After" = inline(crate::auth::RetryAfterSeconds), description = "Jittered retry delay in seconds (1 through 5)"))),
        (status = 500, description = "Database failure or commit barrier timeout", body = ErrorBody)))]
pub async fn reply_counts(
    State(state): State<AppState>,
    DeferredOrganizationAuth(auth): DeferredOrganizationAuth,
    path: Result<Path<(Uuid, Uuid)>, PathRejection>,
    ApiJson(input): ApiJson<ReplyCountRequest>,
) -> Result<Response, MessageError> {
    let Path((_, channel)) = path.map_err(|_| MessageError::InvalidInput)?;
    if !(1..=100).contains(&input.ids.len()) {
        return Err(MessageError::InvalidInput);
    }
    let auth = auth.ok_or(MessageError::OrganizationUnavailable)?;
    let organization = auth.identity.organization.organization_id;
    let member = (auth.identity.member.id, auth.membership_revision);
    require_visible_scoped(&state.pool, organization, member, channel).await?;
    tokio::time::timeout(admission::WORK_TIMEOUT, async {
        let w = topics::watermark(&state, organization, channel).await?;
        #[cfg(test)]
        tests::replies::counts::pause(channel).await;
        crate::database::organization_read_only(
            &state.pool,
            organization,
            async |tx: &mut sqlx::PgConnection| {
                require_visible(&mut *tx, organization, member, channel).await?;
                let counts = sqlx::query(COUNTS_SQL)
                    .bind(organization)
                    .bind(channel)
                    .bind(&input.ids)
                    .bind(w)
                    .try_map(|row| {
                        Ok(ReplyCount {
                            message_id: row.try_get("message_id")?,
                            root_id: row.try_get("root_id")?,
                            reply_count: row.try_get("reply_count")?,
                        })
                    })
                    .fetch_all(&mut *tx)
                    .await?;
                Ok((
                    [(header::CACHE_CONTROL, "no-store")],
                    Json(ReplyCountPage {
                        as_of_seq: w,
                        counts,
                    }),
                )
                    .into_response())
            },
        )
        .await
    })
    .await
    .map_err(|_| MessageError::Database(sqlx::Error::Io(std::io::ErrorKind::TimedOut.into())))?
}
