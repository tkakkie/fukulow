use sqlx::{PgConnection, PgPool};
use std::time::Duration;
use uuid::Uuid;

const INTERVAL: Duration = Duration::from_secs(60);
const DEADLINE: Duration = Duration::from_secs(2);
pub(super) const BATCH_SIZE: i64 = 1_000;

/// One revision per transaction, at most BATCH_SIZE index rows and one empty counter.
pub(super) async fn batch(pool: &PgPool, org: Uuid) -> Result<(u64, u64), sqlx::Error> {
    crate::database::organization(pool, org, async |tx: &mut PgConnection| {
        reclaim(tx, org).await
    })
    .await
}

pub(super) async fn reclaim(tx: &mut PgConnection, org: Uuid) -> Result<(u64, u64), sqlx::Error> {
    sqlx::query("SET LOCAL statement_timeout = '1s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL transaction_timeout = '1500ms'")
        .execute(&mut *tx)
        .await?;
    // Auth owns the monotone revision projection. No Member/grant locks: a
    // committed higher revision proves that all old-revision writers ended.
    let sql = format!(
        "SELECT c.member_id,c.membership_revision FROM dm_discovery_counters c \
             JOIN ({}) u ON u.organization_id=c.organization_id AND u.id=c.member_id \
             WHERE c.organization_id=$1 AND c.membership_revision<u.membership_revision \
             ORDER BY c.member_id,c.membership_revision LIMIT 1 FOR UPDATE OF c SKIP LOCKED",
        crate::auth::members::MEMBER_REVISIONS_SQL
    );
    let revision: Option<(Uuid, i64)> = sqlx::query_as(&sql)
        .bind(org)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((member, revision)) = revision else {
        return Ok((0, 0));
    };
    // Counter before index, as on writers. No earlier-order lock is acquired.
    let rows = sqlx::query(
        "DELETE FROM dm_discovery WHERE organization_id=$1 AND member_id=$2 \
             AND membership_revision=$3 AND channel_id IN (\
             SELECT channel_id FROM dm_discovery WHERE organization_id=$1 AND member_id=$2 \
             AND membership_revision=$3 ORDER BY channel_id LIMIT $4)",
    )
    .bind(org)
    .bind(member)
    .bind(revision)
    .bind(BATCH_SIZE)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let counters = sqlx::query(
        "DELETE FROM dm_discovery_counters c WHERE c.organization_id=$1 AND c.member_id=$2 \
             AND c.membership_revision=$3 AND NOT EXISTS (SELECT 1 FROM dm_discovery d \
             WHERE d.organization_id=$1 AND d.member_id=$2 AND d.membership_revision=$3)",
    )
    .bind(org)
    .bind(member)
    .bind(revision)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    Ok((rows, counters))
}

/// Single-flight periodic work, independent of traffic; each tick visits one Organization.
pub async fn run(pool: PgPool, shutdown: crate::shutdown::Shutdown) {
    run_with_interval(pool, shutdown, INTERVAL).await;
}

pub(super) async fn run_with_interval(
    pool: PgPool,
    shutdown: crate::shutdown::Shutdown,
    interval: Duration,
) {
    let mut timer = tokio::time::interval(interval);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut after = None;
    loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => return,
            _ = timer.tick() => {}
        }
        let work = async {
            if let Some(org) =
                crate::auth::members::next_maintenance_organization(&pool, after).await?
            {
                // Even a failed Organization must not starve the others.
                after = Some(org);
                let (rows, counters) = batch(&pool, org).await?;
                if rows != 0 || counters != 0 {
                    eprintln!(
                        "event=dm_discovery_reclaimed organization_id={org} rows={rows} counters={counters}"
                    );
                }
            }
            Ok::<_, sqlx::Error>(())
        };
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => return,
            result = tokio::time::timeout(DEADLINE, work) => {
                if !matches!(result, Ok(Ok(()))) {
                    eprintln!("event=database_failure operation=dm_discovery_reclamation");
                }
            }
        }
    }
}
