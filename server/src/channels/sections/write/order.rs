use super::*;

pub(super) async fn sections(
    tx: &mut PgConnection,
    owner: Owner,
    input: SectionOrder,
) -> Result<Change, ApiError> {
    let current: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM member_sections WHERE organization_id=$1 AND member_id=$2 ORDER BY position,id",
    )
    .bind(owner.org).bind(owner.member).fetch_all(&mut *tx).await?;
    let owned: HashSet<_> = current.iter().collect();
    if input.section_ids.iter().any(|id| !owned.contains(id)) {
        return Err(section_not_found());
    }
    if input.section_ids.len() != current.len() {
        return Err(layout_changed());
    }
    if input.section_ids == current {
        return Ok(unchanged());
    }
    sqlx::query(
        "UPDATE member_sections s SET position=desired.position-1
         FROM UNNEST($3::uuid[]) WITH ORDINALITY AS desired(id,position)
         WHERE s.organization_id=$1 AND s.member_id=$2 AND s.id=desired.id AND s.position<>desired.position-1",
    )
    .bind(owner.org).bind(owner.member).bind(input.section_ids).execute(tx).await?;
    Ok(Change::Layout)
}

pub(super) async fn move_channel(
    tx: &mut PgConnection,
    owner: Owner,
    channel: Uuid,
    input: MoveChannel,
    authorize_channels: impl FnOnce(usize) -> Result<(), ApiError>,
) -> Result<Change, ApiError> {
    authorize_channels(1)?;
    require_destination(tx, owner, input.section_id).await?;
    let current: Option<Option<Uuid>> = sqlx::query_scalar(
        "SELECT section_id FROM member_section_placements
         WHERE organization_id=$1 AND member_id=$2 AND channel_id=$3",
    )
    .bind(owner.org)
    .bind(owner.member)
    .bind(channel)
    .fetch_optional(&mut *tx)
    .await?;
    if current.flatten() == input.section_id {
        return Ok(unchanged());
    }
    let group = if input.section_id.is_some() {
        "section_id=$4"
    } else {
        "section_id IS NULL"
    };
    sqlx::query(&format!(
        "INSERT INTO member_section_placements (organization_id,member_id,channel_id,section_id,position)
         SELECT $1,$2,$3,$4,COALESCE(max(position)+1,0) FROM member_section_placements
         WHERE organization_id=$1 AND member_id=$2 AND {group}
         ON CONFLICT (organization_id,member_id,channel_id)
         DO UPDATE SET section_id=EXCLUDED.section_id,position=EXCLUDED.position",
    ))
    .bind(owner.org).bind(owner.member).bind(channel).bind(input.section_id).execute(tx).await?;
    Ok(Change::Layout)
}

pub(super) async fn channels(
    tx: &mut PgConnection,
    owner: Owner,
    input: ChannelOrder,
    authorize_channels: impl FnOnce(usize) -> Result<(), ApiError>,
) -> Result<Change, ApiError> {
    require_destination(tx, owner, input.section_id).await?;
    authorize_channels(input.channel_ids.len())?;
    // This is the only set-validation read. Public creation may commit
    // afterwards and is serialized after this reorder in the automatic tail.
    let slots = channels::group_slots(tx, owner, input.section_id).await?;
    let current: Vec<_> = slots
        .iter()
        .filter(|slot| slot.visible)
        .map(|slot| slot.channel_id)
        .collect();
    let required: HashSet<_> = current.iter().collect();
    if input.channel_ids.len() != current.len()
        || input.channel_ids.iter().any(|id| !required.contains(id))
    {
        return Err(layout_changed());
    }
    if input.channel_ids == current {
        return Ok(unchanged());
    }
    let mut position = -1_i64;
    let positions: Vec<_> = slots
        .into_iter()
        .filter_map(|slot| {
            let next = match slot.position {
                Some(explicit) => Some(explicit),
                None => position.checked_add(1),
            };
            if let Some(next) = next {
                position = next;
            }
            slot.visible.then_some(next)
        })
        .collect::<Option<_>>()
        .ok_or(ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal error",
            None,
        ))?;
    sqlx::query(
        "INSERT INTO member_section_placements (organization_id,member_id,channel_id,section_id,position)
         SELECT $1,$2,desired.id,$3,desired.position
         FROM UNNEST($4::uuid[],$5::bigint[]) AS desired(id,position)
         ON CONFLICT (organization_id,member_id,channel_id)
         DO UPDATE SET position=EXCLUDED.position
         WHERE member_section_placements.position<>EXCLUDED.position",
    )
    .bind(owner.org).bind(owner.member).bind(input.section_id).bind(input.channel_ids).bind(positions).execute(tx).await?;
    Ok(Change::Layout)
}

async fn require_destination(
    tx: &mut PgConnection,
    owner: Owner,
    destination: Option<Uuid>,
) -> Result<(), ApiError> {
    if let Some(id) = destination {
        read::section_name(tx, owner, id).await?;
    }
    Ok(())
}
