use super::*;
use crate::auth::{Action, Actor, Resource, authorize};
use fukulow_api::{MessageEventType, MessageMoveEvent, MoveEventKind};
use sha2::{Digest, Sha256};
use sqlx::PgConnection;

const MAX_CHAIN: usize = 1_000;

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MoveChainRequest {
    pub history_generation: Option<Uuid>,
    pub operation_id: Uuid,
    #[schema(minimum = 1)]
    pub expected_version: i64,
    /// Supply exactly one of topic_id and topic_name.
    pub topic_id: Option<Uuid>,
    /// Joins an existing normalized name or creates a Topic in this Channel.
    #[schema(min_length = 1, max_length = 60)]
    pub topic_name: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct MoveChainResponse {
    pub history_generation: Uuid,
    pub operation_id: Uuid,
    pub root_id: Uuid,
    /// The destination of this operation, even after a subsequent Move.
    pub destination_topic_id: Uuid,
    /// The version written by the operation, or the accepted version for a no-op.
    pub operation_version: i64,
    /// Event position of this operation; null for a same-Topic no-op.
    #[schema(required = true)]
    pub move_seq: Option<i64>,
    /// Current chain version, including any intervening operations or Replies.
    pub chain_version: i64,
    /// Current Topic of the chain.
    pub topic_id: Uuid,
}

struct Move {
    organization: Uuid,
    channel: Uuid,
    member: (Uuid, i64),
    anchor: Uuid,
    input: MoveChainRequest,
}

impl Move {
    fn operation(&self) -> receipts::Operation {
        let mut digest = Sha256::new();
        digest.update(b"fukulow.move.v1");
        digest.update(self.input.expected_version.to_be_bytes());
        if let Some(id) = self.input.topic_id {
            digest.update([0]);
            digest.update(id.as_bytes());
        } else if let Some(name) = &self.input.topic_name {
            digest.update([1]);
            digest.update(name.to_ascii_lowercase().as_bytes());
        }
        receipts::Operation {
            actor: self.member.0,
            operation_id: self.input.operation_id,
            kind: receipts::Kind::Move,
            channel: self.channel,
            target: self.anchor,
            intent: digest.finalize(),
        }
    }

    async fn destination(&self, tx: &mut PgConnection) -> Result<Option<Uuid>, MessageError> {
        let topic = topics::find(
            tx,
            self.organization,
            self.channel,
            self.input.topic_id,
            self.input.topic_name.as_deref(),
        )
        .await?;
        if topic.is_none() && self.input.topic_id.is_some() {
            return Err(MessageError::TopicNotFound);
        }
        Ok(topic)
    }
}

/// Move the entire Reply chain identified by a root or descendant Message.
#[utoipa::path(post, path = "/api/v1/orgs/{org}/channels/{id}/messages/{message_id}/move",
    params(("org" = Uuid, Path), ("id" = Uuid, Path), ("message_id" = Uuid, Path, description = "Root or descendant Message in this Reply chain")),
    request_body = MoveChainRequest, security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Committed Move, canonical retry, or same-Topic no-op", body = MoveChainResponse),
        (status = 400, description = "Invalid input, including a nonpositive expected_version or failure to supply exactly one valid Topic destination", body = ErrorBody),
        (status = 401, description = "Account Session unavailable", body = ErrorBody),
        (status = 403, description = "move_not_allowed for a visible chain the caller may not Move", body = ErrorBody),
        (status = 404, description = "Organization, Channel, Message or destination Topic unavailable", body = ErrorBody),
        (status = 409, description = "version_conflict, operation_conflict, chain_too_large or history_generation_changed", body = ErrorBody),
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
        tokio::time::timeout(admission::WORK_TIMEOUT, persist(&state, &request, permit))
            .await
            .map_err(|_| {
                MessageError::Database(sqlx::Error::Io(std::io::ErrorKind::TimedOut.into()))
            })?
    })
    .await
    .map_err(|_| MessageError::Database(sqlx::Error::WorkerCrashed))??;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(outcome)).into_response())
}

#[derive(sqlx::FromRow)]
struct ChainMember {
    id: Uuid,
    reply_to_id: Option<Uuid>,
    seq: i64,
    version: i64,
    sender: Uuid,
    topic_id: Option<Uuid>,
}

struct Chain {
    root: Uuid,
    source: Option<Uuid>,
    version: i64,
    ids: Vec<Uuid>,
}

async fn chain(
    tx: &mut PgConnection,
    request: &Move,
    actor: Actor,
    resource: Resource,
) -> Result<Chain, MessageError> {
    let (_, root) = replies::parent_location(
        tx,
        request.organization,
        request.channel,
        Some(request.anchor),
    )
    .await
    .map_err(|error| match error {
        MessageError::ReplyParentNotFound => MessageError::ReplyChainNotFound,
        error => error,
    })?
    .ok_or(sqlx::Error::RowNotFound)?;
    // Check chain-independent denials before reading the descendants.
    if !authorize(actor, Action::MoveChain { owns_chain: true }, resource).allowed {
        return Err(MessageError::MoveNotAllowed);
    }
    let members: Vec<ChainMember> = sqlx::query_as(
        "SELECT id, reply_to_id, seq, version, sender, topic_id FROM messages \
         WHERE organization_id=$1 AND channel_id=$2 AND id=$3 AND reply_root_id IS NULL \
         UNION ALL (SELECT id, reply_to_id, seq, version, sender, topic_id FROM messages \
         WHERE organization_id=$1 AND channel_id=$2 AND reply_root_id=$3 ORDER BY seq LIMIT $4)",
    )
    .bind(request.organization)
    .bind(request.channel)
    .bind(root)
    .bind(MAX_CHAIN as i64)
    .fetch_all(&mut *tx)
    .await?;
    let owns_chain = members.iter().all(|m| m.sender == request.member.0);
    if !authorize(actor, Action::MoveChain { owns_chain }, resource).allowed {
        return Err(MessageError::MoveNotAllowed);
    }
    // An oversized chain can still replay a prior successful operation. The
    // ownership recheck must include descendants created after that operation.
    if members.len() > MAX_CHAIN
        && !authorize(actor, Action::MoveChain { owns_chain: false }, resource).allowed
    {
        let another_sender: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM messages WHERE organization_id=$1 AND channel_id=$2 \
             AND reply_root_id=$3 AND sender<$4) OR EXISTS (SELECT 1 FROM messages \
             WHERE organization_id=$1 AND channel_id=$2 AND reply_root_id=$3 AND sender>$4)",
        )
        .bind(request.organization)
        .bind(request.channel)
        .bind(root)
        .bind(request.member.0)
        .fetch_one(&mut *tx)
        .await?;
        if another_sender {
            return Err(MessageError::MoveNotAllowed);
        }
    }

    let root_message = members
        .iter()
        .find(|m| m.id == root)
        .ok_or(sqlx::Error::RowNotFound)?;
    let source = root_message.topic_id;
    let version = if members.len() <= MAX_CHAIN {
        validate_members(&members, root, request.anchor, source)?;
        members
            .iter()
            .map(|m| m.version)
            .max()
            .ok_or(sqlx::Error::RowNotFound)?
    } else {
        replies::chain_version(tx, request.organization, request.channel, root, i64::MAX).await?
    };
    let ids = members.into_iter().map(|m| m.id).collect::<Vec<_>>();
    if ids.len() <= MAX_CHAIN {
        let mismatched_child: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM messages WHERE organization_id=$1 AND channel_id=$2 \
             AND reply_to_id=ANY($3) AND reply_root_id IS DISTINCT FROM $4)",
        )
        .bind(request.organization)
        .bind(request.channel)
        .bind(&ids)
        .bind(root)
        .fetch_one(tx)
        .await?;
        if mismatched_child {
            return Err(sqlx::Error::Protocol("inconsistent Reply chain root".into()).into());
        }
    }
    Ok(Chain {
        root,
        source,
        version,
        ids,
    })
}

fn validate_members(
    members: &[ChainMember],
    root: Uuid,
    anchor: Uuid,
    source: Option<Uuid>,
) -> Result<(), sqlx::Error> {
    let by_id: std::collections::HashMap<_, _> = members.iter().map(|m| (m.id, m.seq)).collect();
    if !by_id.contains_key(&anchor)
        || members.iter().any(|m| {
            m.topic_id != source
                || if m.id == root {
                    m.reply_to_id.is_some()
                } else {
                    m.reply_to_id
                        .and_then(|parent| by_id.get(&parent))
                        .is_none_or(|&seq| seq >= m.seq)
                }
        })
    {
        return Err(sqlx::Error::Protocol("inconsistent Reply chain".into()));
    }
    Ok(())
}

enum Prepared {
    Canonical(MoveChainResponse),
    Write(MoveChainResponse, Option<MessageMoveEvent>),
}

async fn persist(
    state: &AppState,
    request: &Move,
    permit: admission::Permit,
) -> Result<MoveChainResponse, MessageError> {
    let org = request.organization;
    let channel = request.channel;
    let mut tx = commit::Transaction::begin(&state.pool, permit, "BEGIN", Some(org)).await?;
    let (outcome, event) = match prepare(tx.connection()?, request).await {
        Err(error) => {
            tx.rollback().await?;
            return Err(error);
        }
        Ok(Prepared::Canonical(outcome)) => {
            tx.rollback().await?;
            return Ok(outcome);
        }
        Ok(Prepared::Write(outcome, event)) => (outcome, event),
    };
    let Some(event) = event else {
        commit::finish(tx, outcome.operation_id).await?;
        return Ok(outcome);
    };
    let delivery = &state.message_delivery;
    let mut notification = delivery.notification(org, channel, event.seq);
    if let Err(error) = commit::finish(tx, outcome.operation_id).await {
        if commit::definitely_rolled_back(&error) {
            notification.complete();
        }
        return Err(error.into());
    }
    delivery
        .channel_access
        .activity
        .message_moved(state.pool.clone(), org, channel, event.seq);
    notification.spawn(state.pool.clone(), ChannelEvent::moved(event));
    Ok(outcome)
}

async fn prepare(tx: &mut PgConnection, request: &Move) -> Result<Prepared, MessageError> {
    let org = request.organization;
    let channel = request.channel;
    let (actor, resource) =
        match channels::lock_move_access(tx, org, request.member, channel).await? {
            channels::MoveAccess::OrganizationUnavailable => {
                return Err(MessageError::OrganizationUnavailable);
            }
            channels::MoveAccess::ChannelUnavailable => return Err(MessageError::NotFound),
            channels::MoveAccess::Visible(actor, resource) => (actor, resource),
        };
    commit::lock(tx, org, channel, false).await?;
    let generation =
        history::validate(tx, org, channel, request.input.history_generation, None).await?;
    let chain = chain(tx, request, actor, resource).await?;
    let operation = request.operation();
    match receipts::resolve(tx, org, &operation).await? {
        receipts::Resolution::Committed(outcome) => {
            let destination = request
                .destination(tx)
                .await?
                .ok_or(sqlx::Error::RowNotFound)?;
            let topic = chain.source.ok_or(sqlx::Error::RowNotFound)?;
            Ok(Prepared::Canonical(MoveChainResponse {
                history_generation: generation,
                operation_id: operation.operation_id,
                root_id: chain.root,
                destination_topic_id: destination,
                operation_version: outcome.version,
                move_seq: outcome.event_seq,
                chain_version: chain.version,
                topic_id: topic,
            }))
        }
        receipts::Resolution::Conflict => Err(MessageError::OperationConflict),
        receipts::Resolution::New => prepare_new(tx, request, chain, operation, generation).await,
    }
}

async fn prepare_new(
    tx: &mut PgConnection,
    request: &Move,
    chain: Chain,
    operation: receipts::Operation,
    generation: Uuid,
) -> Result<Prepared, MessageError> {
    let org = request.organization;
    let channel = request.channel;
    if chain.ids.len() > MAX_CHAIN {
        return Err(MessageError::ChainTooLarge);
    }
    if chain.version != request.input.expected_version {
        return Err(MessageError::VersionConflict);
    }
    let destination = request.destination(tx).await?;
    let same_topic = destination.is_some() && destination == chain.source;
    let move_seq = if same_topic {
        None
    } else {
        Some(log::next_move_position(tx, org, channel).await?)
    };
    let version = move_seq.unwrap_or(chain.version);
    if !receipts::record(
        tx,
        org,
        &operation,
        receipts::Outcome {
            version,
            deleted: false,
            event_seq: move_seq,
        },
    )
    .await?
    {
        // Matching requests use this same Channel barrier. The concurrent winner
        // used another Channel, so its intent necessarily conflicts.
        return Err(MessageError::OperationConflict);
    }
    let destination = match destination {
        Some(id) => id,
        None => topics::join(tx, org, channel, None, request.input.topic_name.as_deref())
            .await?
            .ok_or(sqlx::Error::RowNotFound)?,
    };
    let event = move_seq.map(|seq| MessageMoveEvent {
        event_type: MessageEventType::Message,
        kind: MoveEventKind::Move,
        history_generation: generation,
        channel_id: channel,
        seq,
        version,
        root_id: chain.root,
        source_topic_id: chain.source,
        destination_topic_id: destination,
        operation_id: operation.operation_id,
    });
    if let Some(event) = &event {
        apply_move(tx, org, operation.actor, &chain, event).await?;
    }
    Ok(Prepared::Write(
        MoveChainResponse {
            history_generation: generation,
            operation_id: operation.operation_id,
            root_id: chain.root,
            destination_topic_id: destination,
            operation_version: version,
            move_seq,
            chain_version: version,
            topic_id: destination,
        },
        event,
    ))
}

async fn apply_move(
    tx: &mut PgConnection,
    organization: Uuid,
    actor: Uuid,
    chain: &Chain,
    event: &MessageMoveEvent,
) -> Result<(), sqlx::Error> {
    let (updated, live, consistent): (i64, i64, Option<bool>) = sqlx::query_as(
        "WITH moved AS (UPDATE messages SET topic_id=$4, version=$5 \
         WHERE organization_id=$1 AND channel_id=$2 AND id=ANY($3) \
         RETURNING deleted, topic_id, version) \
         SELECT count(*), count(*) FILTER (WHERE NOT deleted), \
         bool_and(topic_id IS NOT DISTINCT FROM $4 AND version=$5) FROM moved",
    )
    .bind(organization)
    .bind(event.channel_id)
    .bind(&chain.ids)
    .bind(event.destination_topic_id)
    .bind(event.seq)
    .fetch_one(&mut *tx)
    .await?;
    if updated != chain.ids.len() as i64 || consistent != Some(true) {
        return Err(sqlx::Error::Protocol("incomplete Reply chain Move".into()));
    }
    topics::repair_after_move(
        tx,
        organization,
        event.channel_id,
        chain.source,
        event.destination_topic_id,
        live,
    )
    .await?;
    log::record_move(tx, organization, actor, event).await?;
    Ok(())
}
