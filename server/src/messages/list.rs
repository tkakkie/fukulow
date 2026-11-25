use axum::{
    Json,
    extract::{
        Path, Query, State,
        rejection::{PathRejection, QueryRejection},
    },
    http::header,
    response::{IntoResponse, Response},
};
use uuid::Uuid;

use super::{
    ListMessagesQuery, MessageError, MessagePage, ValidateListMessages, history, mentions,
    message_from_row, page::DirectionalPage, require_visible_scoped, topics,
};
use crate::{
    AppState,
    auth::{Auth, ErrorBody},
    channels,
};

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
        super::tests::membership::pause_history(channel_id).await;
        let (history_generation, w) = history::page(tx, organization_id, channel_id, query.history_generation, query.as_of_seq).await?;
        let page = DirectionalPage::new(&query, limit);
        let sql = if page.ascending {
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
        let sql = mentions::page_sql(sql, if page.ascending { "p.seq ASC" } else { "p.seq DESC" });
        let messages = sqlx::query(&sql)
            .bind(organization_id)
            .bind(channel_id)
            .bind(page.cursor)
            .bind(page.fetch_limit())
            .bind(w)
            .try_map(|row| message_from_row(&row))
            .fetch_all(&mut *tx)
            .await?;
        let (messages, has_more) = page.finish(messages);
        Ok((
            [(header::CACHE_CONTROL, "no-store")],
            Json(MessagePage { history_generation, as_of_seq: w, messages, has_more }),
        )
            .into_response())
    })
    .await
}
