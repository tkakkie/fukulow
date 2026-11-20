use super::{ApiError, members};
use sqlx::{PgConnection, PgPool};
use std::{future::Future, time::Duration};
use uuid::Uuid;

const INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const DEADLINE: Duration = Duration::from_secs(2);
pub(super) const BATCH_SIZE: i64 = 100;

// Limit each indexed range before combining it with the others. Grouping by
// id applies the earlier clock to revoked and expired Invites in both ranges.
// New tombstones are visible to the DELETE only through INSERT RETURNING.
pub(super) const BATCH_SQL: &str = "WITH cutoff AS (
    SELECT statement_timestamp() - interval '720 hours' AS at
), candidates AS (
    SELECT id FROM (
        (SELECT id, accepted_at AS at FROM invites
         WHERE organization_id=$1 AND accepted_at <= (SELECT at FROM cutoff)
         ORDER BY accepted_at, id LIMIT $2)
        UNION ALL
        (SELECT id, expires_at AS at FROM invites
         WHERE organization_id=$1 AND accepted_at IS NULL AND expires_at <= (SELECT at FROM cutoff)
         ORDER BY expires_at, id LIMIT $2)
        UNION ALL
        (SELECT id, revoked_at AS at FROM invites
         WHERE organization_id=$1 AND revoked_at <= (SELECT at FROM cutoff)
         ORDER BY revoked_at, id LIMIT $2)
    ) clocks GROUP BY id ORDER BY min(at), id LIMIT $2
), saved AS (
    INSERT INTO invite_tombstones (organization_id,id,created_at,role,owner_cursor,admin_cursor)
    SELECT organization_id,id,created_at,role,owner_cursor,admin_cursor FROM invites
    WHERE organization_id=$1 AND id=ANY(ARRAY(SELECT id FROM candidates)) FOR UPDATE
    ON CONFLICT (organization_id, id) DO NOTHING
    RETURNING id
) DELETE FROM invites WHERE organization_id=$1 AND id=ANY(ARRAY(
    SELECT id FROM saved
    UNION ALL
    SELECT id FROM invite_tombstones
    WHERE organization_id=$1 AND id=ANY(ARRAY(SELECT id FROM candidates))
))";

pub(super) async fn lock_batch(tx: &mut PgConnection, org: Uuid) -> Result<(), ApiError> {
    sqlx::query(
        "SELECT set_config('lock_timeout','250ms',true), \
                set_config('statement_timeout','1s',true), \
                set_config('transaction_timeout','1500ms',true)",
    )
    .execute(&mut *tx)
    .await?;
    members::lock_organization(tx, org).await
}

pub(super) async fn delete_batch(tx: &mut PgConnection, org: Uuid) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(BATCH_SQL)
        .bind(org)
        .bind(BATCH_SIZE)
        .execute(tx)
        .await?
        .rows_affected())
}

pub(super) async fn batch(pool: &PgPool, org: Uuid) -> Result<u64, ApiError> {
    crate::database::organization_detached(pool, org, async |tx: &mut PgConnection| {
        lock_batch(tx, org).await?;
        Ok(delete_batch(tx, org).await?)
    })
    .await
}

async fn sweep(pool: &PgPool) {
    let mut after = None;
    loop {
        let org = match tokio::time::timeout(
            DEADLINE,
            members::next_maintenance_organization(pool, after),
        )
        .await
        {
            Ok(Ok(Some(org))) => org,
            Ok(Ok(None)) => return,
            _ => {
                tracing::warn!(target: "fukulow", event = "database_failure", operation = "invite_cleanup_enumerate");
                return;
            }
        };
        if after.is_some_and(|previous| org <= previous) {
            return; // The enumerator wraps at the end.
        }
        after = Some(org);
        loop {
            match tokio::time::timeout(DEADLINE, batch(pool, org)).await {
                Ok(Ok(rows)) if rows == BATCH_SIZE as u64 => tokio::task::yield_now().await,
                Ok(Ok(_)) => break,
                _ => {
                    tracing::warn!(target: "fukulow", event = "database_failure", operation = "invite_cleanup_batch", organization_id = %org);
                    break;
                }
            }
        }
    }
}

pub async fn run(pool: PgPool, cancelled: impl Future<Output = ()> + Send) {
    run_with_interval(pool, cancelled, INTERVAL).await;
}

pub(super) async fn run_with_interval(
    pool: PgPool,
    cancelled: impl Future<Output = ()> + Send,
    interval: Duration,
) {
    tokio::pin!(cancelled);
    let mut timer = tokio::time::interval(interval);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = &mut cancelled => return,
            _ = timer.tick() => {}
        }
        tokio::select! {
            biased;
            _ = &mut cancelled => return,
            _ = sweep(&pool) => {}
        }
    }
}
