use super::{Message, MessageError, REPLAY_PAGE_SIZE, mentions, message_from_row};
use sqlx::{PgConnection, PgPool, Row, postgres::PgRow};
use uuid::Uuid;

use fukulow_api::{MessageMoveEvent, MessageStateKind, ServerEvent};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(transparent)]
pub(crate) struct ChannelEvent {
    #[serde(skip)]
    pub seq: i64,
    #[serde(skip)]
    pub channel_id: Uuid,
    pub(super) payload: Payload,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(untagged)]
pub(super) enum Payload {
    Create(Message),
    Move(MessageMoveEvent),
}

impl ChannelEvent {
    pub fn create(message: Message) -> Self {
        Self {
            seq: message.created_seq,
            channel_id: message.channel_id,
            payload: Payload::Create(message),
        }
    }

    pub(super) fn moved(event: MessageMoveEvent) -> Self {
        Self {
            seq: event.seq,
            channel_id: event.channel_id,
            payload: Payload::Move(event),
        }
    }

    pub(crate) fn into_wire(self) -> ServerEvent {
        match self.payload {
            Payload::Create(message) => ServerEvent::Message {
                seq: self.seq,
                kind: MessageStateKind::Create,
                message,
            },
            Payload::Move(event) => ServerEvent::Move(event),
        }
    }

    #[cfg(test)]
    pub(crate) fn message(&self) -> &Message {
        let Payload::Create(message) = &self.payload else {
            panic!("expected a Create event");
        };
        message
    }
}

impl From<Message> for ChannelEvent {
    fn from(value: Message) -> Self {
        Self::create(value)
    }
}

pub(super) async fn allocate(
    tx: &mut PgConnection,
    organization: Uuid,
    channel: Uuid,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "INSERT INTO channel_message_sequences (organization_id, channel_id, seq) VALUES ($1, $2, 1) \
         ON CONFLICT (organization_id, channel_id) DO UPDATE SET seq = channel_message_sequences.seq + 1 \
         RETURNING seq",
    ).bind(organization).bind(channel).fetch_one(tx).await
}

// The exclusive Channel barrier makes this candidate stable until the Move
// commits. Claim the operation key before writing the counter.
pub(super) async fn next_move_position(
    tx: &mut PgConnection,
    organization: Uuid,
    channel: Uuid,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT seq + 1 FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(organization)
    .bind(channel)
    .fetch_one(tx)
    .await
}

pub(super) async fn record_move(
    tx: &mut PgConnection,
    organization: Uuid,
    actor: Uuid,
    event: &MessageMoveEvent,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO channel_log (organization_id, channel_id, event_seq, kind, message_id, sender, operation_id, source_topic_id, destination_topic_id) \
         VALUES ($1, $2, $3, 'move', $4, $5, $6, $7, $8)",
    )
    .bind(organization).bind(event.channel_id).bind(event.seq)
    .bind(event.root_id).bind(actor).bind(event.operation_id)
    .bind(event.source_topic_id).bind(event.destination_topic_id)
    .execute(&mut *tx).await?;
    let advanced = sqlx::query(
        "UPDATE channel_message_sequences SET seq=$3, mutation_seq=$3 \
         WHERE organization_id=$1 AND channel_id=$2 AND seq=$3-1",
    )
    .bind(organization)
    .bind(event.channel_id)
    .bind(event.seq)
    .execute(tx)
    .await?
    .rows_affected();
    if advanced != 1 {
        return Err(sqlx::Error::RowNotFound);
    }
    Ok(())
}

pub(super) async fn create(
    tx: &mut PgConnection,
    organization: Uuid,
    message: &Message,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO channel_log (organization_id, channel_id, event_seq, kind, message_id, sender, client_message_id) \
         VALUES ($1, $2, $3, 'create', $4, $5, $6)",
    )
    .bind(organization)
    .bind(message.channel_id)
    .bind(message.created_seq)
    .bind(message.id)
    .bind(message.sender)
    .bind(message.client_message_id)
    .execute(tx)
    .await?;
    Ok(())
}

// Limit positions before hydrating current state. LEFT JOIN keeps an unhydratable
// position visible to validation instead of silently acknowledging past it.
// Keep the Message lookup correlated. Planning before the RLS context exists
// can underestimate the cost of materializing all Messages in the Organization.
// OFFSET 0 is an optimisation fence: it stops the subquery being pulled up into
// a plain join; removing it can restore the Organization-wide scan (#515).
fn page_sql(channel: usize, authorized: bool) -> String {
    let (after, through, limit) = (channel + 1, channel + 2, channel + 3);
    let access = if authorized { "AND access.visible" } else { "" };
    format!(
        r#"WITH log_page AS MATERIALIZED (
            SELECT organization_id, channel_id, event_seq, kind, message_id, source_topic_id, destination_topic_id, operation_id FROM channel_log
            WHERE organization_id=$1 AND channel_id=${channel} AND event_seq>${after} AND event_seq<=${through} {access}
            ORDER BY event_seq LIMIT ${limit}
        )
        SELECT l.event_seq,l.kind,l.message_id,l.source_topic_id,l.destination_topic_id,l.operation_id,
            l.channel_id AS log_channel_id,m.id,m.channel_id,m.seq,m.version,m.deleted,m.client_message_id,m.sender,m.body,m.topic_id,
            m.reply_to_id AS reply_to,m.reply_root_id,
            to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
        FROM log_page l LEFT JOIN LATERAL (
            SELECT * FROM messages
            WHERE organization_id=l.organization_id AND channel_id=l.channel_id AND id=l.message_id AND l.kind='create'
            OFFSET 0
        ) m ON true
        ORDER BY l.event_seq"#
    )
}

fn hydrate(rows: Vec<PgRow>, mut after: i64) -> Result<Vec<ChannelEvent>, sqlx::Error> {
    let mut messages = Vec::with_capacity(rows.len());
    let only = rows.len() == 1;
    for row in rows {
        let Some(position) = row.try_get::<Option<i64>, _>("event_seq")? else {
            if only {
                continue; // Authorized empty page's LEFT JOIN sentinel.
            }
            return Err(sqlx::Error::RowNotFound);
        };
        if after.checked_add(1) != Some(position) {
            return Err(sqlx::Error::RowNotFound);
        }
        let event = match row.try_get::<&str, _>("kind")? {
            "create" if row.try_get::<Option<i64>, _>("seq")? == Some(position) => {
                ChannelEvent::create(message_from_row(&row)?)
            }
            "move" => ChannelEvent::moved(MessageMoveEvent {
                event_type: fukulow_api::MessageEventType::Message,
                kind: fukulow_api::MoveEventKind::Move,
                history_generation: row.try_get("history_generation")?,
                channel_id: row.try_get("log_channel_id")?,
                seq: position,
                version: position,
                root_id: row.try_get("message_id")?,
                source_topic_id: row.try_get("source_topic_id")?,
                destination_topic_id: row.try_get("destination_topic_id")?,
                operation_id: row.try_get("operation_id")?,
            }),
            _ => return Err(sqlx::Error::RowNotFound),
        };
        messages.push(event);
        after = position;
    }
    Ok(messages)
}

pub(super) fn replay_page_sql() -> String {
    mentions::page_sql(&page_sql(2, false), "p.event_seq")
}

pub(super) fn authorized_page_sql() -> String {
    let sql = format!(
        "WITH access AS MATERIALIZED (SELECT ({}) AS visible) \
         SELECT access.visible,m.* FROM access LEFT JOIN LATERAL ({}) m ON true ORDER BY m.event_seq",
        crate::channels::member_visibility_sql(false),
        page_sql(4, true)
    );
    mentions::page_sql(&sql, "p.event_seq")
}

pub(crate) async fn replay_page(
    pool: &PgPool,
    organization: Uuid,
    channel: Uuid,
    after: i64,
    through: i64,
) -> Result<Vec<ChannelEvent>, sqlx::Error> {
    let sql = replay_page_sql();
    let rows = crate::database::organization_statement(
        pool,
        &sql,
        async |tx: &mut PgConnection, sql: &str| {
            let sql = format!("{sql} ORDER BY event_seq");
            sqlx::query(&sql)
                .bind(organization)
                .bind(channel)
                .bind(after)
                .bind(through)
                .bind(REPLAY_PAGE_SIZE)
                .fetch_all(tx)
                .await
        },
    )
    .await?;
    hydrate(rows, after)
}

// Authorization, log coverage and current state share one snapshot per page.
pub(crate) async fn authorized_replay_page(
    pool: &PgPool,
    organization: Uuid,
    member: (Uuid, i64),
    channel: Uuid,
    after: i64,
    through: i64,
) -> Result<Vec<ChannelEvent>, MessageError> {
    authorized_page(
        pool,
        organization,
        member,
        channel,
        (after, through),
        REPLAY_PAGE_SIZE,
        None,
    )
    .await
    .map(|(_, events)| events)
}

async fn authorized_page(
    pool: &PgPool,
    organization: Uuid,
    member: (Uuid, i64),
    channel: Uuid,
    bounds: (i64, i64),
    limit: i64,
    generation: Option<Uuid>,
) -> Result<(Uuid, Vec<ChannelEvent>), MessageError> {
    let (after, through) = bounds;
    let sql = authorized_page_sql();
    // PostgreSQL's cost model always picks a custom plan here, and re-planning
    // took about twice the execution time (#515). The generic plan keeps the
    // bounded shape checked in tests/replay_plans.rs.
    let rows = crate::database::organization_statement_generic(
        pool,
        &sql,
        async |tx: &mut PgConnection, sql: &str| {
            let sql = format!("{sql} ORDER BY event_seq");
            sqlx::query(&sql)
                .bind(organization)
                .bind(member.0)
                .bind(member.1)
                .bind(channel)
                .bind(after)
                .bind(through)
                .bind(limit)
                .fetch_all(tx)
                .await
        },
    )
    .await?;
    match rows
        .first()
        .ok_or(sqlx::Error::RowNotFound)?
        .try_get::<Option<bool>, _>("visible")?
    {
        None => return Err(MessageError::OrganizationUnavailable),
        Some(false) => return Err(MessageError::NotFound),
        Some(true) => {}
    }
    let history_generation: Uuid = rows
        .first()
        .ok_or(sqlx::Error::RowNotFound)?
        .try_get("history_generation")?;
    if generation.is_some_and(|old| old != history_generation) {
        return Err(MessageError::HistoryGenerationChanged);
    }
    Ok((history_generation, hydrate(rows, after)?))
}

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
    use axum::response::IntoResponse;
    let axum::extract::Path((_, channel)) = path.map_err(|_| MessageError::InvalidInput)?;
    let axum::extract::Query(query) = query.map_err(|_| MessageError::InvalidInput)?;
    let limit = query.limit.unwrap_or(50);
    if query.after_seq < 0 || !(1..=200).contains(&limit) {
        return Err(MessageError::InvalidInput);
    }
    let organization = auth.identity.organization.organization_id;
    let member = (auth.identity.member.id, auth.membership_revision);
    super::require_visible_scoped(&state.pool, organization, member, channel).await?;
    let through = super::topics::watermark(&state, organization, channel).await?;
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
    Ok((
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        axum::Json(fukulow_api::ChannelEventPage {
            history_generation,
            events,
            has_more,
        }),
    )
        .into_response())
}
