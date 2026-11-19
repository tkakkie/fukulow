use super::*;
use std::collections::HashMap;

#[utoipa::path(get, path="/api/v1/orgs/{org}/me/sections",
    params(("org"=Uuid,Path)), security(("cookie"=[]),("bearer"=[])),
    responses((status=200,description="Personal layout with accessible active Channels only",body=SectionLayout),
    (status=400,description="invalid input",body=ErrorBody), (status=401,description="invalid credentials",body=ErrorBody),
    (status=404,description="organization_unavailable",body=ErrorBody), (status=500,description="internal error",body=ErrorBody)))]
pub(crate) async fn layout(
    State(state): State<AppState>,
    owner: Owner,
) -> Result<Json<SectionLayout>, ApiError> {
    crate::database::organization_read_only(&state.pool, owner.org, async |tx| {
        owner.current_role(tx, false).await?;
        let generation = owner.generation(tx).await?.to_string();
        let rows: Vec<(Uuid, String)> = sqlx::query_as(
            "SELECT id, name FROM member_sections WHERE organization_id=$1 AND member_id=$2 ORDER BY position, id",
        )
        .bind(owner.org)
        .bind(owner.member)
        .fetch_all(&mut *tx)
        .await?;
        let mut groups: HashMap<_, Vec<_>> = HashMap::new();
        for (channel, section) in channels::visible_layout(tx, owner).await? {
            groups.entry(section).or_default().push(channel);
        }
        let sections = rows.into_iter().map(|(id, name)| Section {
            id,
            name,
            channel_ids: groups.remove(&Some(id)).unwrap_or_default(),
        }).collect();
        Ok(Json(SectionLayout {
            generation,
            sections,
            other_channel_ids: groups.remove(&None).unwrap_or_default(),
        }))
    }).await
}

#[utoipa::path(get, path="/api/v1/orgs/{org}/me/sections/{id}",
    params(("org"=Uuid,Path),("id"=Uuid,Path)), security(("cookie"=[]),("bearer"=[])),
    responses((status=200,description="Owned section with accessible active Channels only",body=SectionSnapshot),
    (status=400,description="invalid input",body=ErrorBody), (status=401,description="invalid credentials",body=ErrorBody),
    (status=404,description="organization_unavailable or section_not_found",body=ErrorBody),
    (status=500,description="internal error",body=ErrorBody)))]
pub(crate) async fn section(
    State(state): State<AppState>,
    owner: Owner,
    TargetId(id): TargetId,
) -> Result<Json<SectionSnapshot>, ApiError> {
    crate::database::organization_read_only(&state.pool, owner.org, async |tx| {
        owner.current_role(tx, false).await?;
        let name = section_name(tx, owner, id).await?;
        let generation = owner.generation(tx).await?.to_string();
        let channel_ids = channels::group_slots(tx, owner, Some(id))
            .await?
            .into_iter()
            .filter_map(|slot| slot.visible.then_some(slot.channel_id))
            .collect();
        Ok(Json(SectionSnapshot {
            generation,
            section: Section {
                id,
                name,
                channel_ids,
            },
        }))
    })
    .await
}

#[utoipa::path(get, path="/api/v1/orgs/{org}/me/channel-sections/{channel_id}",
    params(("org"=Uuid,Path),("channel_id"=Uuid,Path)), security(("cookie"=[]),("bearer"=[])),
    responses((status=200,description="Group of an accessible active ordinary Channel",body=ChannelPlacement),
    (status=400,description="invalid input",body=ErrorBody), (status=401,description="invalid credentials",body=ErrorBody),
    (status=404,description="organization_unavailable or channel not found",body=ErrorBody),
    (status=409,description="channel_archived",body=ErrorBody),
    (status=500,description="internal error",body=ErrorBody)))]
pub(crate) async fn placement(
    State(state): State<AppState>,
    owner: Owner,
    TargetId(channel): TargetId,
) -> Result<Json<ChannelPlacement>, ApiError> {
    crate::database::organization_read_only(&state.pool, owner.org, async |tx| {
        owner.current_role(tx, false).await?;
        let section_id = channels::visible_placement(tx, owner, channel).await?;
        let generation = owner.generation(tx).await?.to_string();
        Ok(Json(ChannelPlacement {
            generation,
            section_id,
        }))
    })
    .await
}

pub(crate) async fn section_name(
    tx: &mut PgConnection,
    owner: Owner,
    id: Uuid,
) -> Result<String, ApiError> {
    sqlx::query_scalar(
        "SELECT name FROM member_sections WHERE organization_id=$1 AND member_id=$2 AND id=$3",
    )
    .bind(owner.org)
    .bind(owner.member)
    .bind(id)
    .fetch_optional(tx)
    .await?
    .ok_or_else(section_not_found)
}
