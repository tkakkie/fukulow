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
    auth::{
        self, Action, Actor, ApiError, ApiJson, Auth, Capability, ErrorBody, Resource, Role,
        authorize,
    },
};

#[derive(Debug, Serialize, Deserialize, ToSchema, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "text", rename_all = "snake_case")]
pub enum ChannelVisibility {
    Public,
    Private,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct Channel {
    pub id: Uuid,
    /// 1..=128 Unicode scalar values.
    #[schema(min_length = 1, max_length = 128)]
    pub name: String,
    pub visibility: ChannelVisibility,
    pub capabilities: ChannelCapabilities,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ChannelCapabilities {
    pub can_add_members: Capability,
    pub can_remove_members: Capability,
    pub can_leave: Capability,
    pub can_manage_managers: Capability,
}

impl ChannelCapabilities {
    fn for_visible(organization: Uuid, role: Role, public: bool, manager: bool) -> Self {
        let actor = Actor::Member {
            organization,
            role,
            channel_member: true,
            channel_manager: manager,
        };
        let resource = Resource::Channel {
            organization,
            public,
        };
        Self {
            can_manage_managers: authorize(actor, Action::ManageChannelManagers, resource),
            can_remove_members: authorize(actor, Action::RemoveChannelMembers, resource),
            can_leave: authorize(actor, Action::LeaveChannel, resource),
            can_add_members: authorize(
                Actor::Member {
                    organization,
                    role,
                    channel_member: true,
                    channel_manager: manager,
                },
                Action::AddChannelMembers,
                Resource::Channel {
                    organization,
                    public,
                },
            ),
        }
    }
}

/// Identity and organization come from the session, never from request fields.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateChannelRequest {
    /// 1..=128 Unicode scalar values; no NUL.
    /// Leading or trailing whitespace, as defined by Rust `str::trim()`, is rejected, not trimmed.
    /// Internal whitespace is allowed.
    #[schema(min_length = 1, max_length = 128)]
    pub name: String,
    pub visibility: ChannelVisibility,
}

// The caller can compose the visible list with Messages-owned Unread data in
// one snapshot without querying Channel tables outside their owning module.
pub(crate) async fn visible_list<'e, E: sqlx::PgExecutor<'e>>(
    executor: E,
    auth: &Auth,
) -> Result<Vec<Channel>, ApiError> {
    auth.require(Action::ReadOrganization)?;
    let visible = visible_channel_sql();
    // The LEFT JOIN retains one empty row for an active Member with no visible Channels.
    let sql = format!(
        "SELECT c.id, c.name, c.visibility, u.role, EXISTS (SELECT 1 FROM channel_members cm WHERE cm.organization_id=c.organization_id AND cm.channel_id=c.id AND cm.member_id=u.id AND cm.membership_revision=u.membership_revision AND cm.manager) FROM ({}) u \
         LEFT JOIN channels c ON c.organization_id = $1 \
         AND ({visible}) WHERE u.id = $2 AND u.membership_revision = $3 \
         ORDER BY lower(c.name COLLATE \"C\"), c.id",
        auth::ACTIVE_MEMBERS_SQL
    );
    let rows = sqlx::query_as::<
        _,
        (
            Option<Uuid>,
            Option<String>,
            Option<ChannelVisibility>,
            Role,
            bool,
        ),
    >(&sql)
    .bind(auth.identity.organization.organization_id)
    .bind(auth.identity.member.id)
    .bind(auth.membership_revision)
    .fetch_all(executor)
    .await?;
    if rows.is_empty() {
        return Err(ApiError::organization_unavailable());
    }
    let channels = rows
        .into_iter()
        .filter_map(|(id, name, visibility, role, manager)| {
            let visibility = visibility?;
            let capabilities = ChannelCapabilities::for_visible(
                auth.identity.organization.organization_id,
                role,
                matches!(visibility, ChannelVisibility::Public),
                manager,
            );
            Some(Channel {
                id: id?,
                name: name?,
                visibility,
                capabilities,
            })
        })
        .collect();
    Ok(channels)
}

/// Create a public or private channel with an organization-unique name.
/// Names are compared with ASCII case folding; non-ASCII characters are unchanged.
/// A private channel includes its creator as a member in the same transaction.
#[utoipa::path(post, path = "/api/v1/orgs/{org}/channels", request_body = CreateChannelRequest,
    params(("org" = Uuid, Path, description = "Organization id")),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 201, description = "Created Channel; a private Channel includes its creator as a Member", body = Channel),
        (status = 400, description = "Malformed Organization id, invalid Channel JSON or fields; name must be 1..=128 Unicode scalar values, NUL-free and without surrounding whitespace", body = ErrorBody),
        (status = 401, description = "Missing, invalid, expired, or revoked Account Session credential", body = ErrorBody),
        (status = 403, description = "forbidden: Guests cannot create Channels", body = ErrorBody),
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
    auth::validate_text(&input.name)?;
    if input.name.is_empty() || input.name.chars().count() > 128 || input.name != input.name.trim()
    {
        return Err(ApiError::bad_request());
    }
    let organization_id = auth.identity.organization.organization_id;
    let task_state = state.clone();
    let channel = tokio::spawn(async move {
    let state = task_state;
    let channel = crate::database::organization(&state.pool, organization_id, async |tx: &mut sqlx::PgConnection| {
        if matches!(input.visibility, ChannelVisibility::Private) {
            auth::members::lock_organization(&mut *tx, organization_id).await?;
        }
        let actor = auth::members::current_actor(&mut *tx, &auth, Action::CreateChannel).await?;
        let role = match actor {
            Actor::Member { role, .. } => role,
            _ => return Err(ApiError::forbidden()),
        };
        let channel = match sqlx::query_as::<_, (Uuid, String, ChannelVisibility)>(
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
                return Err(ApiError(StatusCode::CONFLICT, "channel name already exists", None));
            }
            Err(error) => return Err(error.into()),
        };
        let channel = Channel {
            id: channel.0,
            name: channel.1,
            capabilities: ChannelCapabilities::for_visible(
                organization_id,
                role,
                matches!(channel.2, ChannelVisibility::Public),
                matches!(channel.2, ChannelVisibility::Private),
            ),
            visibility: channel.2,
        };
        if matches!(channel.visibility, ChannelVisibility::Private) {
            sqlx::query(
                "INSERT INTO channel_members (organization_id, channel_id, member_id, membership_revision, manager) \
                 VALUES ($1, $2, $3, $4, true)",
            )
            .bind(organization_id)
            .bind(channel.id)
            .bind(auth.identity.member.id)
            .bind(auth.membership_revision)
            .execute(&mut *tx)
            .await?;
        }
        Ok::<_, ApiError>(channel)
    }).await?;
    state.session_changes.channel_changed(state.pool.clone(), organization_id, auth::activity::ChannelChange::Created { channel: channel.id, creator: auth.identity.member.id, public: matches!(channel.visibility, ChannelVisibility::Public) });
    Ok::<_, ApiError>(channel)
    }).await.map_err(|_| ApiError::from(sqlx::Error::WorkerCrashed))??;
    Ok((
        StatusCode::CREATED,
        [(header::CACHE_CONTROL, "no-store")],
        Json(channel),
    )
        .into_response())
}

// All Channel authorization paths share the same grant predicate (aliases c and u).
fn visible_channel_sql() -> String {
    let public_roles = auth::authorization::channel_roles_sql(false);
    let explicit_roles = auth::authorization::channel_roles_sql(true);
    format!(
        "(c.visibility = 'public' AND u.role IN ({public_roles})) OR (u.role IN ({explicit_roles}) AND EXISTS (SELECT 1 FROM channel_members cm \
    WHERE cm.organization_id = c.organization_id AND cm.channel_id = c.id \
    AND cm.member_id = u.id AND cm.membership_revision = u.membership_revision))"
    )
}

fn visibility_sql(member_sql: &str, channel_parameter: &str) -> String {
    let visible = visible_channel_sql();
    format!(
        "SELECT u.id, u.membership_revision, EXISTS (SELECT 1 FROM channels c \
         WHERE c.organization_id = $1 AND c.id = {channel_parameter} \
         AND ({visible})) AS visible FROM ({member_sql}) u"
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
    // Lock Member first, then the grant through COMMIT. DELETE/renewal cannot
    // pass an admitted send or mark-read; public non-Guests need no grant.
    let sql = format!("SELECT role FROM ({}) u", auth::current_member_sql(true));
    let role: Option<Role> = sqlx::query_scalar(&sql)
        .bind(organization_id)
        .bind(member.0)
        .bind(member.1)
        .fetch_optional(&mut *connection)
        .await?;
    let Some(role) = role else {
        return Ok(None);
    };
    let public: Option<bool> = sqlx::query_scalar(
        "SELECT visibility = 'public' FROM channels WHERE organization_id=$1 AND id=$2",
    )
    .bind(organization_id)
    .bind(channel_id)
    .fetch_optional(&mut *connection)
    .await?;
    let Some(public) = public else {
        return Ok(Some(false));
    };
    if authorize(
        Actor::Member {
            organization: organization_id,
            role,
            channel_member: false,
            channel_manager: false,
        },
        Action::ReadChannel,
        Resource::Channel {
            organization: organization_id,
            public,
        },
    )
    .allowed
    {
        return Ok(Some(true));
    }
    let grant: Option<Uuid> = sqlx::query_scalar("SELECT member_id FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 AND membership_revision=$4 FOR SHARE")
        .bind(organization_id).bind(channel_id).bind(member.0).bind(member.1).fetch_optional(connection).await?;
    Ok(Some(
        authorize(
            Actor::Member {
                organization: organization_id,
                role,
                channel_member: grant.is_some(),
                channel_manager: false,
            },
            Action::ReadChannel,
            Resource::Channel {
                organization: organization_id,
                public,
            },
        )
        .allowed,
    ))
}

// All Member locks precede every grant lock. The Channel lock holds visibility
// stable and is taken before Members, matching access-changing transactions.
pub(crate) async fn authorize_send_targets(
    connection: &mut sqlx::PgConnection,
    organization: Uuid,
    sender: (Uuid, i64),
    channel: Uuid,
    targets: &[Uuid],
) -> Result<(Option<bool>, Vec<Uuid>), sqlx::Error> {
    let public: Option<bool> = sqlx::query_scalar(
        "SELECT visibility='public' FROM channels WHERE organization_id=$1 AND id=$2 FOR SHARE",
    )
    .bind(organization)
    .bind(channel)
    .fetch_optional(&mut *connection)
    .await?;
    let mut ids = targets.to_vec();
    ids.push(sender.0);
    ids.sort_unstable();
    ids.dedup();
    let members = auth::members::lock_send_members(connection, organization, &ids).await?;
    if !members
        .iter()
        .any(|&(id, revision, _)| (id, revision) == sender)
    {
        return Ok((None, Vec::new()));
    }
    let Some(public) = public else {
        return Ok((Some(false), Vec::new()));
    };
    let grants: Vec<(Uuid, i64)> = sqlx::query_as(
        "SELECT member_id,membership_revision FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=ANY($3) ORDER BY member_id FOR SHARE",
    ).bind(organization).bind(channel).bind(&ids).fetch_all(connection).await?;
    let mut accepted = Vec::new();
    let mut sender_visible = false;
    for (id, revision, role) in members {
        let visible = authorize(
            Actor::Member {
                organization,
                role,
                channel_member: grants.contains(&(id, revision)),
                channel_manager: false,
            },
            Action::ReadChannel,
            Resource::Channel {
                organization,
                public,
            },
        )
        .allowed;
        if id == sender.0 {
            sender_visible = visible;
        }
        if visible && targets.contains(&id) {
            accepted.push(id);
        }
    }
    Ok((Some(sender_visible), accepted))
}

pub(crate) async fn is_visible_scoped(
    pool: &sqlx::PgPool,
    organization: Uuid,
    member: (Uuid, i64),
    channel: Uuid,
) -> Result<Option<bool>, sqlx::Error> {
    crate::database::organization_statement(
        pool,
        &member_visibility_sql(false),
        async |connection: &mut sqlx::PgConnection, sql: &str| {
            sqlx::query_scalar(sql)
                .bind(organization)
                .bind(member.0)
                .bind(member.1)
                .bind(channel)
                .fetch_optional(connection)
                .await
        },
    )
    .await
}

async fn member_visibility<'e, E: sqlx::PgExecutor<'e>>(
    executor: E,
    organization_id: Uuid,
    member: (Uuid, i64),
    channel_id: Uuid,
    lock: bool,
) -> Result<Option<bool>, sqlx::Error> {
    let sql = member_visibility_sql(lock);
    sqlx::query_scalar(&sql)
        .bind(organization_id)
        .bind(member.0)
        .bind(member.1)
        .bind(channel_id)
        .fetch_optional(executor)
        .await
}

// Projection reads compose this predicate with their data in one fresh snapshot
// after the commit barrier. Bind Organization, Member, revision, Channel in order.
pub(crate) fn member_visibility_sql(lock: bool) -> String {
    format!(
        "SELECT visible FROM ({}) visibility",
        visibility_sql(&auth::current_member_sql(lock), "$4")
    )
}

#[cfg(test)]
fn visible_members_sql() -> String {
    format!(
        "SELECT v.id, v.membership_revision FROM ({}) v \
         JOIN UNNEST($3::uuid[], $4::bigint[]) candidate(id, revision) \
         ON v.id = candidate.id AND v.membership_revision = candidate.revision WHERE v.visible",
        visibility_sql(&auth::candidate_members_sql(), "$2")
    )
}

// Match each socket's captured revision, including multiple epochs for the same Member.
#[cfg(test)]
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

mod access;
pub mod members;
pub use access::AccessChanges;
pub(crate) use access::AccessWatch;
#[cfg(test)]
pub(crate) use access::access_row_for_test;

pub(crate) async fn member_access(
    pool: &sqlx::PgPool,
    organization: Uuid,
    channel: Uuid,
    members: &[(Uuid, i64)],
) -> Result<Vec<(Uuid, i64, bool)>, sqlx::Error> {
    let (ids, revisions): (Vec<_>, Vec<_>) = members.iter().copied().unzip();
    let sql = format!(
        "SELECT v.id,v.membership_revision,v.visible FROM ({}) v JOIN UNNEST($3::uuid[], $4::bigint[]) candidate(id,revision) ON v.id=candidate.id AND v.membership_revision=candidate.revision",
        visibility_sql(&auth::candidate_members_sql(), "$2")
    );
    crate::database::organization_statement(
        pool,
        &sql,
        async |tx: &mut sqlx::PgConnection, sql: &str| {
            sqlx::query_as(sql)
                .bind(organization)
                .bind(channel)
                .bind(ids)
                .bind(revisions)
                .fetch_all(tx)
                .await
        },
    )
    .await
}

pub(crate) async fn member_access_in(
    connection: &mut sqlx::PgConnection,
    organization: Uuid,
    channel: Uuid,
    members: &[(Uuid, i64)],
) -> Result<Vec<(Uuid, i64, bool)>, sqlx::Error> {
    let (ids, revisions): (Vec<_>, Vec<_>) = members.iter().copied().unzip();
    let sql = format!(
        "SELECT v.id,v.membership_revision,v.visible FROM ({}) v JOIN UNNEST($3::uuid[], $4::bigint[]) candidate(id,revision) ON v.id=candidate.id AND v.membership_revision=candidate.revision",
        visibility_sql(&auth::candidate_members_sql(), "$2")
    );
    sqlx::query_as(&sql)
        .bind(organization)
        .bind(channel)
        .bind(ids)
        .bind(revisions)
        .fetch_all(connection)
        .await
}
#[cfg(test)]
mod tests;

pub(crate) mod activity;
