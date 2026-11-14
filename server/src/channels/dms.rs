use super::*;
use sqlx::PgConnection;

mod cursor;
pub(crate) mod discovery;
#[cfg(test)]
mod tests;
pub(crate) use cursor::Cursor;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DmKind {
    Dm,
}
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum OrdinaryChannelKind {
    Channel,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DmPeer {
    pub id: Uuid,
    pub name: String,
    pub active: bool,
}
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DmDiscovery {
    pub id: Uuid,
    pub kind: DmKind,
    pub peer: DmPeer,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct OpenDmRequest {
    pub member_id: Uuid,
    #[serde(default)]
    pub renew: bool,
}

pub(crate) struct SelectedDm {
    pub identity: DmDiscovery,
    pub created_at: String,
}

pub(crate) async fn is_dm(
    connection: &mut PgConnection,
    org: Uuid,
    channel: Uuid,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM channels WHERE organization_id=$1 AND id=$2 AND kind='dm')",
    )
    .bind(org)
    .bind(channel)
    .fetch_one(connection)
    .await
}

pub(crate) async fn reject_membership(
    connection: &mut PgConnection,
    org: Uuid,
    channel: Uuid,
) -> Result<(), ApiError> {
    if is_dm(connection, org, channel).await? {
        Err(ApiError(
            StatusCode::BAD_REQUEST,
            "dm_membership_fixed",
            None,
        ))
    } else {
        Ok(())
    }
}

pub(crate) async fn pair(
    connection: &mut PgConnection,
    org: Uuid,
    channel: Uuid,
) -> Result<Option<(Uuid, Uuid)>, sqlx::Error> {
    sqlx::query_as("SELECT lower_member_id,higher_member_id FROM channels WHERE organization_id=$1 AND id=$2 AND kind='dm'")
        .bind(org).bind(channel).fetch_optional(connection).await
}

pub(crate) async fn open(
    connection: &mut PgConnection,
    auth: &Auth,
    input: &OpenDmRequest,
) -> Result<(Uuid, bool), ApiError> {
    let org = auth.identity.organization.organization_id;
    let caller = auth.identity.member.id;
    auth::members::lock_organization(connection, org).await?;
    let caller_rows = auth::members::participants(connection, org, &[caller], false).await?;
    let fresh = caller_rows
        .first()
        .filter(|m| m.active && m.membership_revision == auth.membership_revision)
        .ok_or_else(ApiError::organization_unavailable)?;
    auth::authorization::require(
        Actor::Member {
            organization: org,
            role: fresh.role,
            channel_member: false,
            channel_manager: false,
        },
        Action::OpenDm,
        Resource::Organization(org),
    )?;
    if caller == input.member_id {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "dm_self_not_allowed",
            None,
        ));
    }
    let mut ids = [caller, input.member_id];
    ids.sort();
    let existing: Option<Uuid> = sqlx::query_scalar("SELECT id FROM channels WHERE organization_id=$1 AND lower_member_id=$2 AND higher_member_id=$3 AND kind='dm' FOR NO KEY UPDATE")
        .bind(org).bind(ids[0]).bind(ids[1]).fetch_optional(&mut *connection).await?;
    let members = auth::members::participants(connection, org, &ids, true).await?;
    let actor = members
        .iter()
        .find(|m| m.id == caller && m.active && m.membership_revision == auth.membership_revision)
        .ok_or_else(ApiError::organization_unavailable)?;
    auth::authorization::require(
        Actor::Member {
            organization: org,
            role: actor.role,
            channel_member: false,
            channel_manager: false,
        },
        Action::OpenDm,
        Resource::Organization(org),
    )?;
    let grants: Vec<(Uuid, i64, Uuid)> = if let Some(channel) = existing {
        sqlx::query_as("SELECT member_id,membership_revision,grant_id FROM channel_members WHERE organization_id=$1 AND channel_id=$2 ORDER BY member_id FOR UPDATE")
            .bind(org).bind(channel).fetch_all(&mut *connection).await?
    } else {
        Vec::new()
    };
    if !input.renew
        && let Some(channel) = existing
        && grants
            .iter()
            .any(|g| g.0 == caller && g.1 == auth.membership_revision)
    {
        return Ok((channel, false));
    }
    members
        .iter()
        .find(|m| m.id == input.member_id && m.active)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "member_not_found", None))?;
    let channel = existing.unwrap_or_else(Uuid::new_v4);
    let lifetimes: Vec<_> = members
        .iter()
        .map(|m| {
            let current = grants
                .iter()
                .find(|g| g.0 == m.id && g.1 == m.membership_revision);
            (
                m.id,
                m.membership_revision,
                current.map(|g| g.2).unwrap_or_else(Uuid::new_v4),
                current.is_none(),
            )
        })
        .collect();
    if !lifetimes.iter().any(|g| g.3) {
        return Ok((channel, false));
    }
    if existing.is_none() {
        sqlx::query("INSERT INTO channels(organization_id,id,kind,lower_member_id,higher_member_id) VALUES($1,$2,'dm',$3,$4)")
            .bind(org).bind(channel).bind(ids[0]).bind(ids[1]).execute(&mut *connection).await?;
    }
    // Deferred grant FKs permit discovery writes before grant baseline triggers.
    discovery::bump(
        connection,
        org,
        channel,
        &lifetimes
            .iter()
            .map(|g| (g.0, g.1, g.2))
            .collect::<Vec<_>>(),
    )
    .await?;
    for (member, revision, grant, changed) in lifetimes {
        if changed {
            sqlx::query("INSERT INTO channel_members(organization_id,channel_id,member_id,membership_revision,grant_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,channel_id,member_id) DO UPDATE SET membership_revision=EXCLUDED.membership_revision,grant_id=EXCLUDED.grant_id,manager=false")
                .bind(org).bind(channel).bind(member).bind(revision).bind(grant).execute(&mut *connection).await?;
        }
    }
    Ok((channel, existing.is_none()))
}

// Grant projection limits the authorized candidate set before identity/count work.
pub(crate) async fn select(
    connection: &mut PgConnection,
    auth: &Auth,
    boundary: Option<(&str, Uuid)>,
    ids: Option<&[Uuid]>,
) -> Result<Vec<SelectedDm>, ApiError> {
    auth::members::require_current(connection, auth).await?;
    let rows:Vec<(Uuid,Uuid,String)>=sqlx::query_as("SELECT cm.channel_id, CASE WHEN c.lower_member_id=$2 THEN c.higher_member_id ELSE c.lower_member_id END, c.created_at::text FROM channel_members cm JOIN channels c ON c.organization_id=cm.organization_id AND c.id=cm.channel_id WHERE cm.organization_id=$1 AND cm.member_id=$2 AND cm.membership_revision=$3 AND cm.dm_created_at IS NOT NULL AND c.kind='dm' AND $2 IN(c.lower_member_id,c.higher_member_id) AND ($4::timestamptz IS NULL OR (cm.dm_created_at,cm.channel_id)<($4::timestamptz,$5::uuid)) AND ($6::uuid[] IS NULL OR cm.channel_id=ANY($6)) ORDER BY cm.dm_created_at DESC,cm.channel_id DESC LIMIT 51")
        .bind(auth.identity.organization.organization_id).bind(auth.identity.member.id).bind(auth.membership_revision)
        .bind(boundary.map(|b|b.0)).bind(boundary.map(|b|b.1)).bind(ids).fetch_all(&mut *connection).await?;
    identities(connection, auth, rows).await
}

pub(crate) async fn identities(
    connection: &mut PgConnection,
    auth: &Auth,
    rows: Vec<(Uuid, Uuid, String)>,
) -> Result<Vec<SelectedDm>, ApiError> {
    let peers = auth::members::participants(
        connection,
        auth.identity.organization.organization_id,
        &rows.iter().map(|r| r.1).collect::<Vec<_>>(),
        false,
    )
    .await?;
    let mut peers: std::collections::HashMap<_, _> = peers
        .into_iter()
        .map(|p| (p.id, (p.name, p.active)))
        .collect();
    rows.into_iter()
        .map(|(id, peer, created_at)| {
            let (name, active) = peers.remove(&peer).ok_or(sqlx::Error::RowNotFound)?;
            Ok(SelectedDm {
                identity: DmDiscovery {
                    id,
                    kind: DmKind::Dm,
                    peer: DmPeer {
                        id: peer,
                        name,
                        active,
                    },
                },
                created_at,
            })
        })
        .collect()
}

pub(crate) async fn send_locks(
    connection: &mut PgConnection,
    org: Uuid,
    sender: (Uuid, i64),
    channel: Uuid,
) -> Result<Option<Vec<(Uuid, i64, Uuid)>>, ApiError> {
    let Some((a, b)) = pair(connection, org, channel).await? else {
        return Ok(None);
    };
    if ![a, b].contains(&sender.0) {
        return Err(ApiError(StatusCode::NOT_FOUND, "channel not found", None));
    }
    let members = auth::members::participants(connection, org, &[a, b], true).await?;
    let actor = members
        .iter()
        .find(|m| m.id == sender.0 && m.active && m.membership_revision == sender.1)
        .ok_or_else(ApiError::organization_unavailable)?;
    let grants:Vec<(Uuid,i64,Uuid)>=sqlx::query_as("SELECT member_id,membership_revision,grant_id FROM channel_members WHERE organization_id=$1 AND channel_id=$2 ORDER BY member_id FOR SHARE")
        .bind(org).bind(channel).fetch_all(&mut *connection).await?;
    if !grants
        .iter()
        .any(|g| g.0 == actor.id && g.1 == actor.membership_revision)
    {
        return Err(ApiError(StatusCode::NOT_FOUND, "channel not found", None));
    }
    Ok(Some(grants))
}

// Call only after the canonical lookup, while send_locks retains both Members/grants.
pub(crate) async fn eligible_peer(
    connection: &mut PgConnection,
    org: Uuid,
    sender: Uuid,
    grants: &[(Uuid, i64, Uuid)],
) -> Result<(), ApiError> {
    let ids = grants
        .iter()
        .map(|g| g.0)
        .filter(|id| *id != sender)
        .collect::<Vec<_>>();
    let peers = auth::members::participants(connection, org, &ids, false).await?;
    let peer = peers.first().filter(|p| p.active).ok_or(ApiError(
        StatusCode::CONFLICT,
        "dm_peer_deactivated",
        None,
    ))?;
    if !grants
        .iter()
        .any(|g| g.0 == peer.id && g.1 == peer.membership_revision)
    {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "dm_peer_access_lapsed",
            None,
        ));
    }
    Ok(())
}
