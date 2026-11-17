use super::{Message, MessageError, REPLAY_PAGE_SIZE, mentions, message_from_row};
use sqlx::{PgConnection, PgPool, Row, postgres::PgRow};
use uuid::Uuid;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(transparent)]
pub(crate) struct ChannelEvent {
    #[serde(skip)]
    pub seq: i64,
    #[serde(skip)]
    pub kind: fukulow_api::ChannelEventKind,
    pub message: Message,
}
impl ChannelEvent {
    pub fn create(message: Message) -> Self {
        Self {
            seq: message.created_seq,
            kind: fukulow_api::ChannelEventKind::Create,
            message,
        }
    }
}
impl std::ops::Deref for ChannelEvent {
    type Target = Message;
    fn deref(&self) -> &Message {
        &self.message
    }
}
impl std::ops::DerefMut for ChannelEvent {
    fn deref_mut(&mut self) -> &mut Message {
        &mut self.message
    }
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
fn page_sql(channel: usize, authorized: bool) -> String {
    let (after, through, limit) = (channel + 1, channel + 2, channel + 3);
    let access = if authorized { "AND access.visible" } else { "" };
    format!(
        r#"WITH log_page AS MATERIALIZED (
            SELECT organization_id, channel_id, event_seq, kind, message_id FROM channel_log
            WHERE organization_id=$1 AND channel_id=${channel} AND event_seq>${after} AND event_seq<=${through} {access}
            ORDER BY event_seq LIMIT ${limit}
        )
        SELECT l.event_seq,l.kind,m.id,m.channel_id,m.seq,m.version,m.client_message_id,m.sender,m.body,m.topic_id,
            m.reply_to_id AS reply_to,m.reply_root_id,
            to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
        FROM log_page l LEFT JOIN messages m
            ON m.organization_id=l.organization_id AND m.channel_id=l.channel_id AND m.id=l.message_id
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
        if after.checked_add(1) != Some(position)
            || row.try_get::<&str, _>("kind")? != "create"
            || row.try_get::<Option<i64>, _>("seq")? != Some(position)
        {
            return Err(sqlx::Error::RowNotFound);
        }
        messages.push(ChannelEvent {
            seq: position,
            kind: fukulow_api::ChannelEventKind::Create,
            message: message_from_row(&row)?,
        });
        after = position;
    }
    Ok(messages)
}

pub(crate) async fn replay_page(
    pool: &PgPool,
    organization: Uuid,
    channel: Uuid,
    after: i64,
    through: i64,
) -> Result<Vec<ChannelEvent>, sqlx::Error> {
    let sql = mentions::page_sql(&page_sql(2, false), "p.event_seq");
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
        after,
        through,
        REPLAY_PAGE_SIZE,
    )
    .await
}

async fn authorized_page(
    pool: &PgPool,
    organization: Uuid,
    member: (Uuid, i64),
    channel: Uuid,
    after: i64,
    through: i64,
    limit: i64,
) -> Result<Vec<ChannelEvent>, MessageError> {
    let sql = format!(
        "WITH access AS MATERIALIZED (SELECT ({}) AS visible) \
         SELECT access.visible,m.* FROM access LEFT JOIN LATERAL ({}) m ON true ORDER BY m.event_seq",
        crate::channels::member_visibility_sql(false),
        page_sql(4, true)
    );
    let sql = mentions::page_sql(&sql, "p.event_seq");
    let rows = crate::database::organization_statement(
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
    Ok(hydrate(rows, after)?)
}

/// Read event positions for C3 gap recovery. Auth extraction and query validation
/// precede Channel visibility, exactly as on the history GET.
#[utoipa::path(get, path = "/api/v1/orgs/{org}/channels/{id}/events",
    params(("org" = Uuid, Path), ("id" = Uuid, Path), fukulow_api::ListChannelEventsQuery),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Ascending Channel event envelopes after the exclusive event cursor, with current-state replay hydration and directional has_more", body = fukulow_api::ChannelEventPage),
        (status = 400, description = "Malformed Organization or Channel id, missing or negative event cursor, or page limit outside 1 through 200", body = crate::auth::ErrorBody),
        (status = 401, description = "Missing, invalid, expired, or revoked Account Session credential", body = crate::auth::ErrorBody),
        (status = 404, description = "organization_unavailable for an unavailable Organization; otherwise Channel is unknown or inaccessible, without disclosing its existence", body = crate::auth::ErrorBody),
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
    let mut events = authorized_page(
        &state.pool,
        auth.identity.organization.organization_id,
        (auth.identity.member.id, auth.membership_revision),
        channel,
        query.after_seq,
        i64::MAX,
        i64::from(limit) + 1,
    )
    .await?;
    let has_more = events.len() > usize::from(limit);
    events.truncate(usize::from(limit));
    let events = events
        .into_iter()
        .map(|event| fukulow_api::ServerEvent::Message {
            seq: event.seq,
            kind: event.kind,
            message: event.message,
        })
        .collect();
    Ok((
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        axum::Json(fukulow_api::ChannelEventPage { events, has_more }),
    )
        .into_response())
}
