use axum::{
    extract::{Path, State, rejection::PathRejection},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use uuid::Uuid;

use super::{
    Message, MessageError, SendMessageRequest, commit, limiter, no_store_json,
    reject_dm_topics_scoped, require_visible_scoped, topics,
};
use crate::{
    AppState,
    auth::{ApiJson, DeferredOrganizationAuth, ErrorBody},
};

mod admitted;
mod receipt;
#[cfg(test)]
pub(super) use admitted::existing;
pub(super) use admitted::persist;
pub(super) use receipt::committed;

/// Send a Message, optionally joining/creating a Topic by name in the same transaction.
/// For all sends, Account Session authentication precedes input validation (400/413/415),
/// which precedes organization_unavailable (404) and Channel authorization, then the
/// per-Member send limit (429), then admission (503).
/// The session supplies organization and sender. A successful retry returns the same
/// canonical message with 201, allocating no new sequence and publishing no new event.
/// A reused client_message_id with different body, Channel, normalized Topic name or reply target returns 409.
#[utoipa::path(post, path = "/api/v1/orgs/{org}/channels/{id}/messages", request_body = SendMessageRequest,
    params(("org" = Uuid, Path, description = "Organization id"), ("id" = Uuid, Path, description = "Channel id")),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 201, description = "Confirmed Message; an idempotent retry returns the same Message and sequence", body = Message),
        (status = 400, description = "Malformed Organization id, Channel id or Message JSON; body must be 1..=4000 scalars, nonblank and NUL-free; topic_name must be 1..=60 scalars, NUL-free and have no surrounding str::trim whitespace; topic_id is forbidden; reply_to with topic_name gives reply_topic_not_allowed; accessible DMs reject non-null Topic intent with dm_topics_not_allowed", body = ErrorBody),
        (status = 401, description = "Missing, invalid, expired, or revoked Account Session credential", body = ErrorBody),
        (status = 404, description = "organization_unavailable for an unavailable Organization; otherwise Channel does not exist or is private and the caller is not a member; reply_parent_not_found for an unknown, uncommitted or foreign Organization/Channel parent", body = ErrorBody),
        (status = 409, description = "history_generation_changed; Client message id reused with different body, Channel, normalized Topic name or reply target; channel_archived; new DM send: dm_peer_deactivated or dm_peer_access_lapsed", body = ErrorBody),
        (status = 413, description = "Message send request body exceeds the size limit", body = ErrorBody),
        (status = 415, description = "Sending a Message requires an application/json content type", body = ErrorBody),
        (status = 429, description = "send_rate_limited: the per-(Organization, Member) send limit (burst 10, 1 per second) is exhausted; checked after Channel authorization and before admission; nothing was charged, queued or persisted; retry after the delay with the same request and client_message_id", body = ErrorBody,
            headers(("Retry-After" = inline(crate::auth::RetryAfterSeconds), description = "Whole seconds until the next token; at least 1"))),
        (status = 500, description = "Database or worker failure while resolving the session, checking Channel visibility, or persisting the Message, including unknown COMMIT outcome or the 10 second database-work deadline; retry with the same client_message_id", body = ErrorBody),
        (status = 503, description = "Send admission queue is full or the 30 second admission wait expired (Retry-After 1 through 5, jittered), or a send-limiter tracking cap is full (Retry-After 1, nothing charged); persistence has not started; retry with the same client_message_id", body = ErrorBody,
            headers(("Retry-After" = inline(crate::auth::RetryAfterSeconds), description = "Retry delay in seconds, at least 1")))))]
pub async fn send_message(
    State(state): State<AppState>,
    DeferredOrganizationAuth(auth): DeferredOrganizationAuth,
    path: Result<Path<(Uuid, Uuid)>, PathRejection>,
    ApiJson(input): ApiJson<SendMessageRequest>,
) -> Result<Response, MessageError> {
    let Path((_, channel_id)) = path.map_err(|_| MessageError::InvalidInput)?;
    input.validate()?;
    let auth = auth.ok_or(MessageError::OrganizationUnavailable)?;
    let organization_id = auth.identity.organization.organization_id;
    let sender = (auth.identity.member.id, auth.membership_revision);
    require_visible_scoped(&state.pool, organization_id, sender, channel_id).await?;
    let limiter = &state.message_delivery.send_limiter;
    let key = (organization_id, sender.0, input.client_message_id);
    let intent = send_intent(channel_id, &input);
    // One execution per key at a time; waiters take no charge or slot. Identical
    // requests settle with that execution; another intent never inherits its failure (S6).
    let mut lead = loop {
        let (mut settled, identical) = match limiter.begin(key, intent) {
            Ok(limiter::Begin::Leader(lead)) => break lead,
            Ok(limiter::Begin::Wait(settled, identical)) => (settled, identical),
            Err(limiter::Refusal::Saturated) => {
                // A committed retry still answers canonically at the tracking cap (S5).
                return match committed(&state.pool, organization_id, sender, channel_id, &input)
                    .await?
                {
                    Some(message) => Ok(created(message)),
                    None => Err(MessageError::LimiterSaturated),
                };
            }
            Err(refusal) => return Err(refusal.into()),
        };
        let _ = settled.changed().await;
        let outcome = settled.borrow().clone();
        if let limiter::Settled::Refused(refusal) = &outcome
            && identical
        {
            if let Some(message) =
                committed(&state.pool, organization_id, sender, channel_id, &input).await?
            {
                return Ok(created(message));
            }
            return Err(refusal.replay());
        }
        if let limiter::Settled::Executed(failure) = outcome {
            if let Some(message) =
                committed(&state.pool, organization_id, sender, channel_id, &input).await?
            {
                return Ok(created(message));
            }
            if let Some(failure) = failure.filter(|_| identical) {
                return Err(failure.replay());
            }
        }
    };
    // A committed retry answers before the limiter and admission (S5).
    if let Some(message) =
        committed(&state.pool, organization_id, sender, channel_id, &input).await?
    {
        return Ok(created(message));
    }
    if input.topic_name.is_some() {
        reject_dm_topics_scoped(&state, &auth, channel_id).await?;
    }
    lead.charge()?;
    #[cfg(test)]
    limiter::charged(input.client_message_id).await;
    let admission = state.message_delivery.admission(&state.pool);
    let waiter = match admission.reserve_send(organization_id, channel_id) {
        Ok(waiter) => waiter,
        Err(refusal) => {
            // Identical waiters share this refusal rather than each paying again.
            lead.refuse(refusal.replay());
            return Err(refusal);
        }
    };
    // Finish persistence even if the HTTP caller disconnects; notification is detached.
    let work = state.message_delivery.work.enter();
    let message = tokio::spawn(async move {
        let _work = work;
        lead.executing();
        let result = persist(
            &state.pool,
            &state.message_delivery,
            organization_id,
            sender,
            channel_id,
            input,
            waiter,
        )
        .await;
        // Only a database failure other than a definite rollback may have committed.
        let failure = result.as_ref().err();
        let unknown = matches!(failure, Some(MessageError::Database(error)) if !commit::definitely_rolled_back(error));
        lead.settle(unknown, failure.map(MessageError::replay));
        result
    })
    .await
    .map_err(|_| MessageError::Database(sqlx::Error::WorkerCrashed))??;
    Ok(created(message))
}

/// Digest of what a send asks for, before normalization: requests that differ only
/// in Topic-name spelling are treated as different and each executes on its own.
fn send_intent(channel_id: Uuid, input: &SendMessageRequest) -> limiter::Intent {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    (channel_id, &input.body, &input.topic_name, input.reply_to).hash(&mut hasher);
    hasher.finish()
}

fn created(message: Message) -> Response {
    (StatusCode::CREATED, no_store_json(message)).into_response()
}

pub(super) trait ValidateSendMessage {
    fn validate(&self) -> Result<(), MessageError>;
}

impl ValidateSendMessage for SendMessageRequest {
    fn validate(&self) -> Result<(), MessageError> {
        if self.reply_to.is_some() && self.topic_name.is_some() {
            return Err(MessageError::ReplyTopicNotAllowed);
        }
        if self.body.contains('\0')
            || self.body.trim().is_empty()
            || self.body.chars().count() > 4000
            || self
                .topic_name
                .as_ref()
                .is_some_and(|name| !topics::valid_name(name))
        {
            return Err(MessageError::InvalidInput);
        }
        Ok(())
    }
}
