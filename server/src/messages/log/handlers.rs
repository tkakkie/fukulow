use uuid::Uuid;

use super::{ChannelEvent, authorized_page};
use crate::messages::{MessageError, no_store_json, valid_page_limit};

/// Read event positions for C3 gap recovery. Auth extraction and query validation
/// precede Channel visibility, exactly as on the history GET.
#[utoipa::path(get, path = "/api/v1/orgs/{org}/channels/{id}/events",
    params(("org" = Uuid, Path), ("id" = Uuid, Path), fukulow_api::ListChannelEventsQuery),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Ascending Channel event envelopes after the exclusive event cursor, with current-state replay hydration and directional has_more", body = fukulow_api::ChannelEventPage),
        (status = 400, description = "Malformed Organization or Channel id, missing or negative event cursor, or page limit outside 1 through 200", body = crate::auth::ErrorBody),
        (status = 401, description = "Missing, invalid, expired, or revoked Account Session credential", body = crate::auth::ErrorBody),
        (status = 409, description = "history_generation_changed for a stale Organization epoch", body = crate::auth::ErrorBody),
        (status = 404, description = "organization_unavailable for an unavailable Organization; otherwise Channel is unknown or inaccessible, without disclosing its existence", body = crate::auth::ErrorBody),
        (status = 503, description = "Committed watermark admission unavailable", body = crate::auth::ErrorBody, headers(("Retry-After" = u64, description = "Retry seconds"))),
        (status = 500, description = "Database failure, missing log coverage, unsupported event kind, or Message state that cannot be hydrated; no positions are acknowledged", body = crate::auth::ErrorBody)))]
pub async fn list_channel_events(
    axum::extract::State(state): axum::extract::State<crate::AppState>,
    auth: crate::auth::Auth,
    path: Result<axum::extract::Path<(Uuid, Uuid)>, axum::extract::rejection::PathRejection>,
    query: Result<
        axum::extract::Query<fukulow_api::ListChannelEventsQuery>,
        axum::extract::rejection::QueryRejection,
    >,
) -> Result<axum::response::Response, MessageError> {
    let axum::extract::Path((_, channel)) = path.map_err(|_| MessageError::InvalidInput)?;
    let axum::extract::Query(query) = query.map_err(|_| MessageError::InvalidInput)?;
    let limit = query.limit.unwrap_or(50);
    if query.after_seq < 0 || !valid_page_limit(limit) {
        return Err(MessageError::InvalidInput);
    }
    let organization = auth.identity.organization.organization_id;
    let member = (auth.identity.member.id, auth.membership_revision);
    super::super::require_visible_scoped(&state.pool, organization, member, channel).await?;
    let through = super::super::watermark::read(&state, organization, channel).await?;
    let (history_generation, mut events) = authorized_page(
        &state.pool,
        auth.identity.organization.organization_id,
        (auth.identity.member.id, auth.membership_revision),
        channel,
        (query.after_seq, through),
        i64::from(limit) + 1,
        query.history_generation,
    )
    .await?;
    let has_more = events.len() > usize::from(limit);
    events.truncate(usize::from(limit));
    let events = events.into_iter().map(ChannelEvent::into_wire).collect();
    Ok(no_store_json(fukulow_api::ChannelEventPage {
        history_generation,
        events,
        has_more,
    }))
}
