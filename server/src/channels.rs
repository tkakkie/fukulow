use axum::{
    Json,
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{self, ApiError, ApiJson, Auth, ErrorBody},
};

#[derive(Debug, Serialize, Deserialize, ToSchema, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "text", rename_all = "snake_case")]
pub enum ChannelVisibility {
    Public,
    Private,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, sqlx::FromRow)]
pub struct Channel {
    pub id: Uuid,
    /// At most 128 Unicode scalar values.
    #[schema(max_length = 128)]
    pub name: String,
    pub visibility: ChannelVisibility,
}

/// Identity and organization come from the session, never from request fields.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateChannelRequest {
    /// At most 128 Unicode scalar values.
    /// Leading or trailing whitespace, as defined by Rust `str::trim()`, is rejected, not trimmed.
    /// Internal whitespace and empty names are allowed.
    #[schema(max_length = 128)]
    pub name: String,
    pub visibility: ChannelVisibility,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ChannelList {
    pub channels: Vec<Channel>,
}

/// List public channels of the caller's organization and private channels they belong to.
#[utoipa::path(get, path = "/api/v1/orgs/{org}/channels",
    params(("org" = Uuid, Path, description = "Organization id")),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Public Channels and private Channels the Member belongs to in their Organization", body = ChannelList),
        (status = 400, description = "Malformed Organization id", body = ErrorBody),
        (status = 401, description = "Missing, invalid, expired, or revoked Account Session credential", body = ErrorBody),
        (status = 404, description = "Non-Member, unknown Organization or deactivated Member: organization_unavailable", body = ErrorBody),
        (status = 500, description = "Database failure while resolving the session or listing visible Channels", body = ErrorBody)))]
pub async fn list_channels(
    State(state): State<AppState>,
    auth: Auth,
) -> Result<Response, ApiError> {
    // The LEFT JOIN retains one empty row for an active Member with no visible Channels.
    let sql = format!(
        "SELECT c.id, c.name, c.visibility FROM ({}) u \
         LEFT JOIN channels c ON c.organization_id = $1 \
         AND ({VISIBLE_CHANNEL_SQL}) WHERE u.id = $2 AND u.membership_revision = $3 \
         ORDER BY lower(c.name COLLATE \"C\"), c.id",
        auth::ACTIVE_MEMBERS_SQL
    );
    let rows = sqlx::query_as::<_, (Option<Uuid>, Option<String>, Option<ChannelVisibility>)>(&sql)
        .bind(auth.identity.organization.organization_id)
        .bind(auth.identity.member.id)
        .bind(auth.membership_revision)
        .fetch_all(&state.pool)
        .await?;
    if rows.is_empty() {
        return Err(ApiError::organization_unavailable());
    }
    let channels = rows
        .into_iter()
        .filter_map(|(id, name, visibility)| {
            Some(Channel {
                id: id?,
                name: name?,
                visibility: visibility?,
            })
        })
        .collect();
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(ChannelList { channels }),
    )
        .into_response())
}

/// Create a public or private channel with an organization-unique name.
/// Names are compared with ASCII case folding; non-ASCII characters are unchanged.
/// A private channel includes its creator as a member in the same transaction.
#[utoipa::path(post, path = "/api/v1/orgs/{org}/channels", request_body = CreateChannelRequest,
    params(("org" = Uuid, Path, description = "Organization id")),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 201, description = "Created Channel; a private Channel includes its creator as a Member", body = Channel),
        (status = 400, description = "Malformed Organization id, invalid Channel JSON or fields, name over 128 Unicode scalar values, or surrounding whitespace", body = ErrorBody),
        (status = 401, description = "Missing, invalid, expired, or revoked Account Session credential", body = ErrorBody),
        (status = 409, description = "Channel name already exists", body = ErrorBody),
        (status = 413, description = "Channel creation request body exceeds the size limit", body = ErrorBody),
        (status = 415, description = "Channel creation requires an application/json content type", body = ErrorBody),
        (status = 404, description = "Non-Member, unknown Organization or deactivated Member: organization_unavailable", body = ErrorBody),
        (status = 500, description = "Database failure while resolving the session or creating the Channel and its membership", body = ErrorBody)))]
pub async fn create_channel(
    State(state): State<AppState>,
    auth: Auth,
    ApiJson(input): ApiJson<CreateChannelRequest>,
) -> Result<Response, ApiError> {
    if input.name.chars().count() > 128 || input.name != input.name.trim() {
        return Ok((
            StatusCode::BAD_REQUEST,
            [(header::CACHE_CONTROL, "no-store")],
            Json(ErrorBody {
                error: "invalid input".into(),
            }),
        )
            .into_response());
    }
    let organization_id = auth.identity.organization.organization_id;
    let mut tx = state.pool.begin().await?;
    let sql = format!("SELECT id FROM ({}) u", auth::current_member_sql(true));
    if sqlx::query_scalar::<_, Uuid>(&sql)
        .bind(organization_id)
        .bind(auth.identity.member.id)
        .bind(auth.membership_revision)
        .fetch_optional(&mut *tx)
        .await?
        .is_none()
    {
        return Err(ApiError::organization_unavailable());
    }
    let channel = match sqlx::query_as::<_, Channel>(
        "INSERT INTO channels (organization_id, id, name, visibility) \
         VALUES ($1, $2, $3, $4) RETURNING id, name, visibility",
    )
    .bind(organization_id)
    .bind(Uuid::new_v4())
    .bind(input.name)
    .bind(input.visibility)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(channel) => channel,
        Err(error)
            if error.as_database_error().is_some_and(|error| {
                error.is_unique_violation()
                    && error.constraint() == Some("channels_organization_name_unique")
            }) =>
        {
            tx.rollback().await?;
            return Ok((
                StatusCode::CONFLICT,
                [(header::CACHE_CONTROL, "no-store")],
                Json(ErrorBody {
                    error: "channel name already exists".into(),
                }),
            )
                .into_response());
        }
        Err(error) => return Err(error.into()),
    };
    if matches!(channel.visibility, ChannelVisibility::Private) {
        sqlx::query(
            "INSERT INTO channel_members (organization_id, channel_id, member_id, membership_revision) \
             VALUES ($1, $2, $3, $4)",
        )
        .bind(organization_id)
        .bind(channel.id)
        .bind(auth.identity.member.id)
        .bind(auth.membership_revision)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok((
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(channel),
    )
        .into_response())
}

// All Channel authorization paths share the same grant predicate (aliases c and u).
const VISIBLE_CHANNEL_SQL: &str = "c.visibility = 'public' OR EXISTS (SELECT 1 FROM channel_members cm \
    WHERE cm.organization_id = c.organization_id AND cm.channel_id = c.id \
    AND cm.member_id = u.id AND cm.membership_revision = u.membership_revision)";

fn visibility_sql(member_sql: &str, channel_parameter: &str) -> String {
    format!(
        "SELECT u.id, u.membership_revision, EXISTS (SELECT 1 FROM channels c \
         WHERE c.organization_id = $1 AND c.id = {channel_parameter} \
         AND ({VISIBLE_CHANNEL_SQL})) AS visible FROM ({member_sql}) u"
    )
}

// None distinguishes Membership loss from an unavailable Channel in one snapshot.
pub(crate) async fn is_visible<'e, E: sqlx::PgExecutor<'e>>(
    executor: E,
    organization_id: Uuid,
    member: (Uuid, i64),
    channel_id: Uuid,
) -> Result<Option<bool>, sqlx::Error> {
    member_visibility(executor, organization_id, member, channel_id, false).await
}

// Only writes retain the Member lock through COMMIT, fencing concurrent deactivation.
pub(crate) async fn is_visible_for_write(
    connection: &mut sqlx::PgConnection,
    organization_id: Uuid,
    member: (Uuid, i64),
    channel_id: Uuid,
) -> Result<Option<bool>, sqlx::Error> {
    member_visibility(connection, organization_id, member, channel_id, true).await
}

async fn member_visibility<'e, E: sqlx::PgExecutor<'e>>(
    executor: E,
    organization_id: Uuid,
    member: (Uuid, i64),
    channel_id: Uuid,
    lock: bool,
) -> Result<Option<bool>, sqlx::Error> {
    let sql = format!(
        "SELECT visible FROM ({}) visibility",
        visibility_sql(&auth::current_member_sql(lock), "$4")
    );
    sqlx::query_scalar(&sql)
        .bind(organization_id)
        .bind(member.0)
        .bind(member.1)
        .bind(channel_id)
        .fetch_optional(executor)
        .await
}

fn visible_members_sql() -> String {
    format!(
        "SELECT v.id, v.membership_revision FROM ({}) v \
         JOIN UNNEST($3::uuid[], $4::bigint[]) candidate(id, revision) \
         ON v.id = candidate.id AND v.membership_revision = candidate.revision WHERE v.visible",
        visibility_sql(&auth::candidate_members_sql(), "$2")
    )
}

// Match each socket's captured revision, including multiple epochs for the same Member.
pub(crate) async fn visible_members(
    pool: &sqlx::PgPool,
    organization_id: Uuid,
    channel_id: Uuid,
    members: &[(Uuid, i64)],
) -> Result<Vec<(Uuid, i64)>, sqlx::Error> {
    let (ids, revisions): (Vec<_>, Vec<_>) = members.iter().copied().unzip();
    sqlx::query_as(&visible_members_sql())
        .bind(organization_id)
        .bind(channel_id)
        .bind(ids)
        .bind(revisions)
        .fetch_all(pool)
        .await
}

#[cfg(test)]
mod tests;
