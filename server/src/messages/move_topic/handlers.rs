use axum::{
    extract::{Path, State, rejection::PathRejection},
    response::Response,
};
use uuid::Uuid;

use super::{Move, MoveChainRequest, MoveChainResponse, persist};
use crate::{
    AppState,
    auth::{ApiJson, DeferredOrganizationAuth, ErrorBody},
    messages::{MessageError, admission, no_store_json, require_visible_scoped, topics},
};

/// Move the entire Reply chain identified by a root or descendant Message.
#[utoipa::path(post, path = "/api/v1/orgs/{org}/channels/{id}/messages/{message_id}/move",
    params(("org" = Uuid, Path), ("id" = Uuid, Path), ("message_id" = Uuid, Path, description = "Root or descendant Message in this Reply chain")),
    request_body = MoveChainRequest, security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Committed Move, canonical retry, or same-Topic no-op", body = MoveChainResponse),
        (status = 400, description = "Invalid input, including a nonpositive expected_version or failure to supply exactly one valid Topic destination", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 403, description = "move_not_allowed for a visible chain the caller may not Move", body = ErrorBody),
        (status = 404, description = "Organization, Channel, Message or destination Topic unavailable", body = ErrorBody),
        (status = 409, description = "version_conflict, operation_conflict, chain_too_large, history_generation_changed or channel_archived", body = ErrorBody),
        (status = 413, description = "Move request body exceeds the size limit", body = ErrorBody),
        (status = 415, description = "Move requires an application/json content type", body = ErrorBody),
        (status = 500, description = "Database or worker failure, including unknown COMMIT outcome; retry with the same operation_id", body = ErrorBody),
        (status = 503, description = "Channel writer admission unavailable", body = ErrorBody,
            headers(("Retry-After" = inline(crate::auth::RetryAfterSeconds), description = "Jittered retry delay in seconds (1 through 5)")))))]
pub async fn move_chain(
    State(state): State<AppState>,
    DeferredOrganizationAuth(auth): DeferredOrganizationAuth,
    path: Result<Path<(Uuid, Uuid, Uuid)>, PathRejection>,
    ApiJson(input): ApiJson<MoveChainRequest>,
) -> Result<Response, MessageError> {
    let Path((_, channel, anchor)) = path.map_err(|_| MessageError::InvalidInput)?;
    if input.expected_version < 1
        || (input.topic_id.is_some() == input.topic_name.is_some())
        || input
            .topic_name
            .as_deref()
            .is_some_and(|name| !topics::valid_name(name))
    {
        return Err(MessageError::InvalidInput);
    }
    let auth = auth.ok_or(MessageError::OrganizationUnavailable)?;
    let request = Move {
        organization: auth.identity.organization.organization_id,
        channel,
        member: (auth.identity.member.id, auth.membership_revision),
        anchor,
        input,
    };
    require_visible_scoped(&state.pool, request.organization, request.member, channel).await?;
    let waiter = state
        .message_delivery
        .admission(&state.pool)
        .reserve_send(request.organization, channel)?;
    let work = state.message_delivery.work.enter();
    let outcome = tokio::spawn(async move {
        let _work = work;
        let permit = waiter.acquire().await?;
        admission::within_work_deadline(persist(&state, &request, permit)).await
    })
    .await
    .map_err(|_| MessageError::Database(sqlx::Error::WorkerCrashed))??;
    Ok(no_store_json(outcome))
}
