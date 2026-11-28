pub(crate) mod handlers;

pub use handlers::list_channel_events;

use super::{
    Message, MessageError, REPLAY_PAGE_SIZE, check_visibility, mentions, message_from_row,
};
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
    main: bool,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "INSERT INTO channel_message_sequences (organization_id, channel_id, seq, main_appended) \
         VALUES ($1, $2, 1, $3::boolean::integer) \
         ON CONFLICT (organization_id, channel_id) DO UPDATE SET seq = channel_message_sequences.seq + 1, \
             main_appended = channel_message_sequences.main_appended + EXCLUDED.main_appended \
         RETURNING seq",
    ).bind(organization).bind(channel).bind(main).fetch_one(tx).await
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

// Merge bounded position scans before hydrating current Message state. Read
// one extra key so a duplicate at the page boundary cannot escape validation.
// OFFSET 0 keeps the state lookup correlated under generic RLS plans (#515).
fn page_sql(channel: usize, authorized: bool) -> String {
    let (after, through, limit) = (channel + 1, channel + 2, channel + 3);
    let access = if authorized { "AND access.visible" } else { "" };
    format!(
        r#"WITH candidates AS (
            (SELECT organization_id, channel_id, seq AS event_seq, 'create'::text AS kind,
                NULL::uuid AS message_id, NULL::uuid AS source_topic_id,
                NULL::uuid AS destination_topic_id, NULL::uuid AS operation_id
             FROM messages
             WHERE organization_id=$1 AND channel_id=${channel} AND seq>${after} AND seq<=${through} {access}
             ORDER BY seq LIMIT (${limit}+1))
            UNION ALL
            (SELECT organization_id, channel_id, event_seq, kind, message_id,
                source_topic_id, destination_topic_id, operation_id
             FROM channel_log
             WHERE organization_id=$1 AND channel_id=${channel} AND event_seq>${after} AND event_seq<=${through} {access}
             ORDER BY event_seq LIMIT (${limit}+1))
            ORDER BY event_seq LIMIT (${limit}+1)
        ), log_page AS MATERIALIZED (
            SELECT *, lead(event_seq) OVER (ORDER BY event_seq) = event_seq AS duplicate
            FROM candidates ORDER BY event_seq LIMIT ${limit}
        )
        SELECT l.event_seq,l.duplicate,l.kind,l.message_id,l.source_topic_id,l.destination_topic_id,l.operation_id,
            l.channel_id AS log_channel_id,m.id,m.channel_id,m.seq,m.version,m.deleted,m.client_message_id,m.sender,m.body,m.topic_id,
            m.reply_to_id AS reply_to,m.reply_root_id,
            to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
        FROM log_page l LEFT JOIN LATERAL (
            SELECT * FROM messages
            WHERE organization_id=l.organization_id AND channel_id=l.channel_id AND seq=l.event_seq AND l.kind='create'
            OFFSET 0
        ) m ON true
        ORDER BY l.event_seq"#
    )
}

pub(super) fn hydrate(
    rows: Vec<PgRow>,
    mut after: i64,
    through: i64,
    limit: i64,
) -> Result<Vec<ChannelEvent>, sqlx::Error> {
    let last_expected = after.max(through.min(after.saturating_add(limit)));
    let mut messages = Vec::with_capacity(rows.len());
    let only = rows.len() == 1;
    for row in rows {
        let Some(position) = row.try_get::<Option<i64>, _>("event_seq")? else {
            if only {
                continue; // Authorized empty page's LEFT JOIN sentinel.
            }
            return Err(sqlx::Error::RowNotFound);
        };
        if after.checked_add(1) != Some(position)
            || row.try_get::<Option<bool>, _>("duplicate")? == Some(true)
        {
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
    if after != last_expected {
        return Err(sqlx::Error::RowNotFound);
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
    hydrate(rows, after, through, REPLAY_PAGE_SIZE)
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
    let rows = crate::database::generic_plan::organization_statement_generic(
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
    check_visibility(
        rows.first()
            .ok_or(sqlx::Error::RowNotFound)?
            .try_get::<Option<bool>, _>("visible")?,
    )?;
    let history_generation: Uuid = rows
        .first()
        .ok_or(sqlx::Error::RowNotFound)?
        .try_get("history_generation")?;
    if generation.is_some_and(|old| old != history_generation) {
        return Err(MessageError::HistoryGenerationChanged);
    }
    Ok((history_generation, hydrate(rows, after, through, limit)?))
}
