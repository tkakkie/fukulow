use super::*;
use tracing::Instrument;

mod handlers;
mod order;
mod section;

pub(crate) use handlers::*;

const DELETE_ATTEMPTS: usize = 3;

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
    Unchanged(Option<(Uuid, i64)>),
}

#[cfg_attr(test, derive(Debug))]
pub(super) enum WriteOutcome {
    Created { id: Uuid, generation: i64 },
    Existing { id: Uuid, generation: i64 },
    Layout,
}

enum WriteExit {
    Unchanged(Option<(Uuid, i64)>),
    RestartDelete(Uuid),
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
                let rows = channels::group_positions(tx, owner, *section).await?;
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
    activity: activity::Activity,
    owner: Owner,
    mutation: Mutation,
) -> Result<WriteOutcome, ApiError> {
    // A disconnected request drops the join handle. The task still owns COMMIT
    // and the publication of its outcome.
    tokio::spawn(write_and_publish(state.pool.clone(), activity, owner, mutation).in_current_span())
        .await
        .map_err(|_| ApiError::from(sqlx::Error::WorkerCrashed))?
}

async fn write_and_publish(
    pool: sqlx::PgPool,
    activity: activity::Activity,
    owner: Owner,
    mut mutation: Mutation,
) -> Result<WriteOutcome, ApiError> {
    for _ in 0..DELETE_ATTEMPTS {
        let committed = write_attempt(&pool, &activity, owner, mutation).await;
        match committed {
            Ok((created, generation, notice)) => {
                notice.committed(pool);
                return Ok(match created {
                    Some(id) => WriteOutcome::Created { id, generation },
                    None => WriteOutcome::Layout,
                });
            }
            Err(WriteExit::Unchanged(existing)) => {
                return Ok(match existing {
                    Some((id, generation)) => WriteOutcome::Existing { id, generation },
                    None => WriteOutcome::Layout,
                });
            }
            Err(WriteExit::RestartDelete(id)) => mutation = Mutation::Delete(id),
            Err(WriteExit::Failed(error)) => return Err(error),
        }
    }
    tracing::warn!(target: "fukulow", "section DELETE restart attempts exhausted");
    Err(ApiError::lock_contention())
}

async fn write_attempt(
    pool: &sqlx::PgPool,
    activity: &activity::Activity,
    owner: Owner,
    mutation: Mutation,
) -> Result<(Option<Uuid>, i64, activity::SectionsPublication), WriteExit> {
    crate::database::organization_confirming_rollback(
        pool,
        owner.org,
        |exit| match exit {
            WriteExit::RestartDelete(_) => true,
            WriteExit::Failed(error) => error.is_lock_contention(),
            WriteExit::Unchanged(_) => false,
        },
        async |tx: &mut PgConnection| {
            write_body(tx, activity, owner, mutation)
                .await
                .map_err(|exit| match exit {
                    WriteExit::Failed(error) => error.classify_write_contention().into(),
                    other => other,
                })
        },
    )
    .await
}

async fn write_body(
    tx: &mut PgConnection,
    activity: &activity::Activity,
    owner: Owner,
    mutation: Mutation,
) -> Result<(Option<Uuid>, i64, activity::SectionsPublication), WriteExit> {
    sqlx::query(crate::database::LOCK_TIMEOUT_SQL)
        .execute(&mut *tx)
        .await?;
    // An absent owned id is already a no-op. Recheck Membership without
    // making unrelated Organization writes wait on that no-op.
    // Read `exists` first only because both paths give the same status and body after the Membership recheck.
    if let Mutation::Delete(id) = &mutation
        && !section::exists(tx, owner, *id).await?
    {
        owner.current_role(tx, true).await?;
        return Err(WriteExit::Unchanged(None));
    }
    auth::members::share_organization(tx, owner.org).await?;
    let channels = mutation.lock_channels(tx, owner).await?;
    let role = owner.current_role(tx, true).await?;
    let grants = if matches!(mutation, Mutation::Move(..) | Mutation::ChannelOrder(_)) {
        channels::lock_grants(tx, owner, role, &channels).await?
    } else {
        HashSet::new()
    };
    lock_layout(tx, owner).await?;
    if let Mutation::Delete(id) = &mutation
        && channels::group_positions(tx, owner, *id)
            .await?
            .iter()
            .any(|(id, _)| channels.binary_search_by_key(id, |row| row.id).is_err())
    {
        // Release the later locks before acquiring the new Channel set.
        return Err(WriteExit::RestartDelete(*id));
    }
    let authorize_channels =
        |count| channels::authorize_supplied(owner, role, count, &channels, &grants);
    let created = match mutation.apply(tx, owner, authorize_channels).await? {
        Change::Unchanged(existing) => return Err(WriteExit::Unchanged(existing)),
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
    let notice = activity.arm_sections(owner.org, owner.member, generation);
    Ok((created, generation, notice))
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
    Change::Unchanged(None)
}
