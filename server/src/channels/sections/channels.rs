use super::*;

pub(super) const LOCK_CHANNELS: &str =
    "SELECT id, visibility='public' AS public, archived_at IS NOT NULL AS archived FROM channels
     WHERE organization_id=$1 AND id=ANY($2) AND kind='channel' ORDER BY id FOR SHARE";

#[derive(sqlx::FromRow)]
pub(super) struct LockedChannel {
    pub(super) id: Uuid,
    public: bool,
    archived: bool,
}

pub(super) async fn group_positions(
    tx: &mut PgConnection,
    owner: Owner,
    section: Uuid,
) -> Result<Vec<(Uuid, i64)>, sqlx::Error> {
    sqlx::query_as(
        "SELECT channel_id, position FROM member_section_placements
         WHERE organization_id=$1 AND member_id=$2 AND section_id=$3 ORDER BY position, channel_id",
    )
    .bind(owner.org)
    .bind(owner.member)
    .bind(section)
    .fetch_all(tx)
    .await
}

pub(super) async fn lock_channels(
    tx: &mut PgConnection,
    org: Uuid,
    ids: &[Uuid],
) -> Result<Vec<LockedChannel>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    sqlx::query_as(LOCK_CHANNELS)
        .bind(org)
        .bind(ids)
        .fetch_all(tx)
        .await
}

pub(super) async fn lock_grants(
    tx: &mut PgConnection,
    owner: Owner,
    role: Role,
    locked: &[LockedChannel],
) -> Result<HashSet<Uuid>, sqlx::Error> {
    let needs_grant: Vec<_> = locked
        .iter()
        .filter_map(|row| (!can_read(owner, role, row.public, false)).then_some(row.id))
        .collect();
    if needs_grant.is_empty() {
        return Ok(HashSet::new());
    }
    Ok(sqlx::query_scalar(
        "SELECT channel_id FROM channel_members WHERE organization_id=$1 AND member_id=$2
         AND membership_revision=$3 AND channel_id=ANY($4) ORDER BY channel_id FOR SHARE",
    )
    .bind(owner.org)
    .bind(owner.member)
    .bind(owner.revision)
    .bind(needs_grant.as_slice())
    .fetch_all(tx)
    .await?
    .into_iter()
    .collect())
}

pub(super) fn authorize_supplied(
    owner: Owner,
    role: Role,
    supplied: usize,
    locked: &[LockedChannel],
    grants: &HashSet<Uuid>,
) -> Result<(), ApiError> {
    if supplied != locked.len()
        || !locked
            .iter()
            .all(|row| can_read(owner, role, row.public, grants.contains(&row.id)))
    {
        return Err(channel_not_found());
    }
    if locked.iter().any(|row| row.archived) {
        return Err(channel_archived());
    }
    Ok(())
}

fn can_read(owner: Owner, role: Role, public: bool, granted: bool) -> bool {
    authorize(
        Actor::Member {
            organization: owner.org,
            role,
            channel_member: granted,
            channel_manager: false,
        },
        Action::ReadChannel,
        Resource::Channel {
            organization: owner.org,
            public,
        },
    )
    .allowed
}

pub(super) async fn visible_layout(
    tx: &mut PgConnection,
    owner: Owner,
) -> Result<Vec<(Uuid, Option<Uuid>)>, sqlx::Error> {
    let member = auth::current_member_sql(false);
    let visible = visible_channel_sql();
    // Keep the placement lookup bound to its full primary key even when the
    // planner underestimates a large layout in a newly populated Organization.
    sqlx::query_as(&format!(
        "SELECT c.id, p.section_id FROM ({member}) u
         JOIN channels c ON c.organization_id=$1 AND c.kind='channel'
         LEFT JOIN LATERAL (
             SELECT section_id, position FROM member_section_placements
             WHERE organization_id=$1 AND member_id=$2 AND channel_id=c.id OFFSET 0
         ) p ON true
         WHERE ({visible}) AND c.archived_at IS NULL
         ORDER BY p.position NULLS LAST, CASE WHEN p.position IS NULL THEN lower(c.name COLLATE \"C\") END, c.id"
    ))
    .bind(owner.org)
    .bind(owner.member)
    .bind(owner.revision)
    .fetch_all(tx)
    .await
}

pub(super) async fn visible_placement(
    tx: &mut PgConnection,
    owner: Owner,
    channel: Uuid,
) -> Result<Option<Uuid>, ApiError> {
    let member = auth::current_member_sql(false);
    let visible = visible_channel_sql();
    let (section_id, archived): (Option<Uuid>, bool) = sqlx::query_as(&format!(
        "SELECT p.section_id, c.archived_at IS NOT NULL FROM ({member}) u
         JOIN channels c ON c.organization_id=$1 AND c.kind='channel' AND c.id=$4
         LEFT JOIN member_section_placements p
           ON p.organization_id=$1 AND p.member_id=$2 AND p.channel_id=c.id
         WHERE ({visible})"
    ))
    .bind(owner.org)
    .bind(owner.member)
    .bind(owner.revision)
    .bind(channel)
    .fetch_optional(tx)
    .await?
    .ok_or_else(channel_not_found)?;
    if archived {
        return Err(channel_archived());
    }
    Ok(section_id)
}

#[derive(sqlx::FromRow)]
pub(super) struct Slot {
    pub channel_id: Uuid,
    pub position: Option<i64>,
    pub visible: bool,
}

pub(super) async fn group_slots(
    tx: &mut PgConnection,
    owner: Owner,
    section: Option<Uuid>,
) -> Result<Vec<Slot>, sqlx::Error> {
    let sql = group_slots_sql(section.is_some());
    let query = sqlx::query_as(&sql)
        .bind(owner.org)
        .bind(owner.member)
        .bind(owner.revision);
    if let Some(section) = section {
        query.bind(section).fetch_all(tx).await
    } else {
        query.fetch_all(tx).await
    }
}

pub(super) fn group_slots_sql(custom: bool) -> String {
    let member = auth::current_member_sql(false);
    let visible = visible_channel_sql();
    let (group, tail) = if custom {
        ("p.section_id=$4", String::new())
    } else {
        (
            "p.section_id IS NULL",
            format!(
                "UNION ALL
             SELECT c.id, NULL, true, lower(c.name COLLATE \"C\")
             FROM ({member}) u JOIN channels c ON c.organization_id=$1 AND c.kind='channel'
             WHERE ({visible}) AND c.archived_at IS NULL AND NOT EXISTS (
                 SELECT 1 FROM member_section_placements p
                 WHERE p.organization_id=$1 AND p.member_id=$2 AND p.channel_id=c.id OFFSET 0)"
            ),
        )
    };
    format!(
        "SELECT channel_id, position, visible FROM (
             SELECT p.channel_id, p.position, (({visible}) AND c.archived_at IS NULL) AS visible, NULL::text AS name
             FROM ({member}) u
             JOIN member_section_placements p ON p.organization_id=$1 AND p.member_id=$2
             JOIN LATERAL (
                 SELECT id, organization_id, kind, visibility, lower_member_id, higher_member_id, archived_at
                 FROM channels WHERE organization_id=$1 AND id=p.channel_id OFFSET 0
             ) c ON true
             WHERE {group}
             {tail}
         ) slots ORDER BY position NULLS LAST, name COLLATE \"C\", channel_id"
    )
}
