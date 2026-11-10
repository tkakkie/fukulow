use super::*;

#[derive(Debug, Serialize, Deserialize, IntoParams, ToSchema)]
#[into_params(parameter_in = Query)]
pub struct ReplyChainQuery {
    /// Exclusive forward continuation; omitted/0 starts with the root.
    #[param(minimum = 0, default = 0)]
    #[schema(minimum = 0)]
    pub after_seq: Option<i64>,
    #[param(minimum = 1, maximum = 200, default = 50)]
    #[schema(minimum = 1, maximum = 200)]
    pub limit: Option<u16>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ReplyChainPage {
    pub root_id: Uuid,
    /// Root and all descendants, ascending by seq. Projection only: never moves the sync cursor.
    pub messages: Vec<Message>,
    /// More matching Messages follow; continue after the last returned seq.
    pub has_more: bool,
}

pub(super) async fn parent(
    connection: &mut sqlx::PgConnection,
    organization: Uuid,
    channel: Uuid,
    id: Option<Uuid>,
) -> Result<Option<Message>, MessageError> {
    let Some(id) = id else { return Ok(None) };
    sqlx::query_as(
        "SELECT id, channel_id, seq, client_message_id, sender, body, topic_id, \
         reply_to_id AS reply_to, reply_root_id, \
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at \
         FROM messages WHERE organization_id=$1 AND channel_id=$2 AND id=$3",
    )
    .bind(organization)
    .bind(channel)
    .bind(id)
    .fetch_optional(connection)
    .await?
    .map(Some)
    .ok_or(MessageError::ReplyParentNotFound)
}

// Separate index branches avoid scanning unrelated Channel Messages or traversing
// ancestors. Each branch yields at most limit+1 rows, including the null-root row.
pub(super) const PAGE_SQL: &str = "SELECT * FROM (\
    (SELECT id, channel_id, seq, client_message_id, sender, body, topic_id, \
      reply_to_id AS reply_to, reply_root_id, \
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at \
     FROM messages WHERE organization_id=$1 AND channel_id=$2 AND id=$3 AND seq>$4 AND seq<=$6) \
    UNION ALL \
    (SELECT id, channel_id, seq, client_message_id, sender, body, topic_id, \
      reply_to_id AS reply_to, reply_root_id, \
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at \
     FROM messages WHERE organization_id=$1 AND channel_id=$2 AND reply_root_id=$3 \
      AND seq>$4 AND seq<=$6 ORDER BY seq LIMIT $5)\
    ) chain ORDER BY seq LIMIT $5";

/// Fetch the root and all descendants from any anchor in the chain. No depth cap.
/// after_seq defaults to 0 and is exclusive; limit defaults to 50, maximum 200.
/// A page is a projection, never evidence of Channel-log contiguity.
#[utoipa::path(get, path = "/api/v1/orgs/{org}/channels/{id}/messages/{message_id}/chain",
    params(("org" = Uuid, Path), ("id" = Uuid, Path), ("message_id" = Uuid, Path), ReplyChainQuery),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Root and all descendants in ascending seq; exclusive continuation with exact has_more; cursor-neutral", body = ReplyChainPage),
        (status = 400, description = "Malformed Organization id, Channel id, Message id or after_seq, negative after_seq, or limit outside 1..=200", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 404, description = "organization_unavailable or channel not found for authorization; reply_chain_not_found for unknown or foreign Organization/Channel anchor", body = ErrorBody),
        (status = 503, description = "Projection watermark admission unavailable; Retry-After gives retry seconds", body = ErrorBody,
            headers(("Retry-After" = inline(crate::auth::RetryAfterSeconds), description = "Jittered retry delay in seconds (1 through 5)"))),
        (status = 500, description = "Database failure or commit barrier timeout reading the Reply chain", body = ErrorBody)))]
pub async fn reply_chain(
    State(state): State<AppState>,
    DeferredOrganizationAuth(auth): DeferredOrganizationAuth,
    path: Result<Path<(Uuid, Uuid, Uuid)>, PathRejection>,
    query: Result<Query<ReplyChainQuery>, QueryRejection>,
) -> Result<Response, MessageError> {
    let Path((_, channel, anchor)) = path.map_err(|_| MessageError::InvalidInput)?;
    let Query(query) = query.map_err(|_| MessageError::InvalidInput)?;
    let limit = query.limit.unwrap_or(50);
    let after = query.after_seq.unwrap_or(0);
    if after < 0 || !(1..=200).contains(&limit) {
        return Err(MessageError::InvalidInput);
    }
    let auth = auth.ok_or(MessageError::OrganizationUnavailable)?;
    let organization = auth.identity.organization.organization_id;
    let member = (auth.identity.member.id, auth.membership_revision);
    require_visible(&state.pool, organization, member, channel).await?;
    tokio::time::timeout(admission::WORK_TIMEOUT, async {
        let w = topics::watermark(&state, organization, channel).await?;
        let mut tx = state
            .pool
            .begin_with("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .await?;
        require_visible(&mut *tx, organization, member, channel).await?;
        let root_id: Uuid = sqlx::query_scalar(
            "SELECT COALESCE(reply_root_id,id) FROM messages \
             WHERE organization_id=$1 AND channel_id=$2 AND id=$3 AND seq<=$4",
        )
        .bind(organization)
        .bind(channel)
        .bind(anchor)
        .bind(w)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(MessageError::ReplyChainNotFound)?;
        let mut messages = sqlx::query_as::<_, Message>(PAGE_SQL)
            .bind(organization)
            .bind(channel)
            .bind(root_id)
            .bind(after)
            .bind(i64::from(limit) + 1)
            .bind(w)
            .fetch_all(&mut *tx)
            .await?;
        tx.commit().await?;
        let has_more = messages.len() > usize::from(limit);
        messages.truncate(usize::from(limit));
        Ok((
            [(header::CACHE_CONTROL, "no-store")],
            Json(ReplyChainPage {
                root_id,
                messages,
                has_more,
            }),
        )
            .into_response())
    })
    .await
    .map_err(|_| MessageError::Database(sqlx::Error::Io(std::io::ErrorKind::TimedOut.into())))?
}
