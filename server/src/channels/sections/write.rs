use super::*;

mod handlers;
mod order;
mod section;

pub(crate) use handlers::*;

pub(super) enum Mutation {
    Create(CreateSection),
    Rename(Uuid, RenameSection),
    Delete(Uuid),
    SectionOrder(SectionOrder),
    Move(Uuid, MoveChannel),
    ChannelOrder(ChannelOrder),
}

enum Change {
    Created(Uuid),
    Layout,
    Unchanged(Response),
}

enum WriteExit {
    Unchanged(Response),
    Failed(ApiError),
}

impl From<ApiError> for WriteExit {
    fn from(error: ApiError) -> Self {
        Self::Failed(error)
    }
}

impl From<sqlx::Error> for WriteExit {
    fn from(error: sqlx::Error) -> Self {
        ApiError::from(error).into()
    }
}

impl Mutation {
    async fn lock_channels(
        &self,
        tx: &mut PgConnection,
        owner: Owner,
    ) -> Result<Vec<channels::LockedChannel>, ApiError> {
        let channels = match self {
            Self::Move(channel, _) => channels::lock_channels(tx, owner.org, &[*channel]).await?,
            Self::ChannelOrder(order) => {
                channels::lock_channels(tx, owner.org, &order.channel_ids).await?
            }
            Self::Delete(section) => {
                let rows: Vec<(Uuid, i64)> = sqlx::query_as(channels::GROUP_POSITIONS)
                    .bind(owner.org)
                    .bind(owner.member)
                    .bind(section)
                    .fetch_all(&mut *tx)
                    .await?;
                let ids: Vec<_> = rows.into_iter().map(|(id, _)| id).collect();
                channels::lock_channels(tx, owner.org, &ids).await?
            }
            _ => Vec::new(),
        };
        Ok(channels)
    }

    async fn apply(
        self,
        tx: &mut PgConnection,
        owner: Owner,
        authorize_channels: impl FnOnce(usize) -> Result<(), ApiError>,
    ) -> Result<Change, ApiError> {
        match self {
            Self::Create(input) => section::create(tx, owner, input).await,
            Self::Rename(id, input) => section::rename(tx, owner, id, input).await,
            Self::Delete(id) => section::delete(tx, owner, id).await,
            Self::SectionOrder(input) => order::sections(tx, owner, input).await,
            Self::Move(channel, input) => {
                order::move_channel(tx, owner, channel, input, authorize_channels).await
            }
            Self::ChannelOrder(input) => {
                order::channels(tx, owner, input, authorize_channels).await
            }
        }
    }
}

pub(super) async fn write(
    state: &AppState,
    owner: Owner,
    mutation: Mutation,
) -> Result<Response, ApiError> {
    let committed =
        crate::database::organization(&state.pool, owner.org, async |tx: &mut PgConnection| {
            // Deletion's exclusive Organization lock stabilizes the placement
            // discovery before Channel locks, including hidden placements.
            if matches!(mutation, Mutation::Delete(_)) {
                auth::members::lock_organization(tx, owner.org).await?;
            } else {
                auth::members::share_organization(tx, owner.org).await?;
            }
            let channels = mutation.lock_channels(tx, owner).await?;
            let role = owner.current_role(tx, true).await?;
            let grants = if matches!(mutation, Mutation::Move(..) | Mutation::ChannelOrder(_)) {
                channels::lock_grants(tx, owner, role, &channels).await?
            } else {
                HashSet::new()
            };
            lock_layout(tx, owner).await?;
            let authorize_channels =
                |count| channels::authorize_supplied(owner, role, count, &channels, &grants);
            let created = match mutation.apply(tx, owner, authorize_channels).await? {
                Change::Unchanged(response) => return Err(WriteExit::Unchanged(response)),
                Change::Created(id) => Some(id),
                Change::Layout => None,
            };
            let generation: i64 = sqlx::query_scalar(
                "UPDATE member_section_generations SET generation=generation+1
             WHERE organization_id=$1 AND member_id=$2 RETURNING generation",
            )
            .bind(owner.org)
            .bind(owner.member)
            .fetch_one(tx)
            .await?;
            Ok((created, generation))
        })
        .await;
    match committed {
        // PR 3 publishes sections_changed here after COMMIT for this owner.
        Ok((created, committed_generation)) => Ok(match created {
            Some(id) => created_section(StatusCode::CREATED, id, committed_generation),
            None => StatusCode::NO_CONTENT.into_response(),
        }),
        Err(WriteExit::Unchanged(response)) => Ok(response),
        Err(WriteExit::Failed(error)) => Err(error),
    }
}

async fn lock_layout(tx: &mut PgConnection, owner: Owner) -> Result<(), sqlx::Error> {
    // The upsert locks an existing row without rewriting it. A no-op rolls
    // back so the initial zero row is also absent after an unchanged request.
    sqlx::query(
        "INSERT INTO member_section_generations (organization_id, member_id) VALUES ($1,$2)
         ON CONFLICT (organization_id,member_id) DO UPDATE SET generation=EXCLUDED.generation WHERE false",
    )
    .bind(owner.org).bind(owner.member).execute(tx).await?;
    Ok(())
}

fn unchanged() -> Change {
    Change::Unchanged(StatusCode::NO_CONTENT.into_response())
}

fn created_section(status: StatusCode, id: Uuid, generation: i64) -> Response {
    (
        status,
        Json(CreatedSection {
            id,
            generation: generation.to_string(),
        }),
    )
        .into_response()
}
