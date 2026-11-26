//! Edit/Move/Delete operation receipts (#515 slice 2). The mutation endpoints
//! (#287, #141) resolve a receipt after reauthorization and before checking
//! `expected_version`, and record it in the mutation's transaction.
//! Resolution ignores expired receipts even before the bounded purge reaches them.
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

mod purge;
#[cfg(test)]
pub(super) use purge::Purge;
pub use purge::purge_periodically;

pub type Digest = sha2::digest::Output<sha2::Sha256>;

/// Lifetime approved on #515. A receipt older than this is ignored and may be
/// replaced. The retry is then a new request, and its stale `expected_version`
/// keeps it from re-executing.
pub const LIFETIME: &str = "7 days";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Edit,
    Move,
    Delete,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Edit => "edit",
            Self::Move => "move",
            Self::Delete => "delete",
        }
    }
}

/// One client operation. The key is `(organization, actor, operation_id)`; the
/// kind, Channel, target and intent digest must all match on a retry.
#[derive(Clone, Copy, Debug)]
pub struct Operation {
    pub actor: Uuid,
    pub operation_id: Uuid,
    pub kind: Kind,
    pub channel: Uuid,
    pub target: Uuid,
    /// SHA-256 of the operation's canonical intent.
    pub intent: Digest,
}

/// What the committed operation produced: the version it wrote, and whether
/// the target is now deleted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub version: i64,
    pub deleted: bool,
    pub event_seq: Option<i64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolution {
    /// No receipt within the lifetime: evaluate as a new request.
    New,
    /// Same key and same intent: answer this outcome, allocate nothing.
    Committed(Outcome),
    /// Same key with a different kind, Channel, target or intent: 409.
    Conflict,
}

const WITHIN_LIFETIME: &str = "created_at > now() - $4::interval";

/// Reads the receipt for this key in the caller's transaction.
pub async fn resolve(
    tx: &mut PgConnection,
    organization: Uuid,
    operation: &Operation,
) -> Result<Resolution, sqlx::Error> {
    let row = sqlx::query(&format!(
        "SELECT kind = $5 AND channel_id = $6 AND target_id = $7 AND intent_digest = $8 AS same, \
         outcome_version, outcome_deleted, outcome_event_seq FROM operation_receipts \
         WHERE organization_id = $1 AND actor = $2 AND operation_id = $3 AND {WITHIN_LIFETIME}"
    ))
    .bind(organization)
    .bind(operation.actor)
    .bind(operation.operation_id)
    .bind(LIFETIME)
    .bind(operation.kind.as_str())
    .bind(operation.channel)
    .bind(operation.target)
    .bind(operation.intent.as_slice())
    .fetch_optional(tx)
    .await?;
    let Some(row) = row else {
        return Ok(Resolution::New);
    };
    if !row.try_get::<bool, _>("same")? {
        return Ok(Resolution::Conflict);
    }
    Ok(Resolution::Committed(Outcome {
        version: row.try_get("outcome_version")?,
        deleted: row.try_get("outcome_deleted")?,
        event_seq: row.try_get("outcome_event_seq")?,
    }))
}

/// Records the receipt in the mutation's transaction. An expired receipt under
/// the same key is replaced. Returns false when a receipt within the lifetime
/// already holds the key: a concurrent request committed first, so the caller
/// rolls back and resolves again.
/// Requires READ COMMITTED, where the conflict re-check sees the committed
/// winner; under REPEATABLE READ or SERIALIZABLE the same race fails with 40001.
pub async fn record(
    tx: &mut PgConnection,
    organization: Uuid,
    operation: &Operation,
    outcome: Outcome,
) -> Result<bool, sqlx::Error> {
    let recorded = sqlx::query(
        "INSERT INTO operation_receipts AS r (organization_id, actor, operation_id, \
         kind, channel_id, target_id, intent_digest, outcome_version, outcome_deleted, outcome_event_seq) \
         VALUES ($1, $2, $3, $5, $6, $7, $8, $9, $10, $11) \
         ON CONFLICT (organization_id, actor, operation_id) DO UPDATE \
         SET kind = EXCLUDED.kind, channel_id = EXCLUDED.channel_id, target_id = EXCLUDED.target_id, \
         intent_digest = EXCLUDED.intent_digest, outcome_version = EXCLUDED.outcome_version, \
         outcome_deleted = EXCLUDED.outcome_deleted, outcome_event_seq = EXCLUDED.outcome_event_seq, created_at = now() \
         WHERE r.created_at <= now() - $4::interval",
    )
    .bind(organization)
    .bind(operation.actor)
    .bind(operation.operation_id)
    .bind(LIFETIME)
    .bind(operation.kind.as_str())
    .bind(operation.channel)
    .bind(operation.target)
    .bind(operation.intent.as_slice())
    .bind(outcome.version)
    .bind(outcome.deleted)
    .bind(outcome.event_seq)
    .execute(tx)
    .await?
    .rows_affected();
    Ok(recorded == 1)
}

const BATCH_ROWS: u64 = 1_000;
const EXPIRED: &str = "organization_id=$1 AND created_at <= now() - $2::interval";
const PURGE_TX_TIMEOUT: &str = "SET LOCAL transaction_timeout = '100ms'";

pub(super) async fn has_expired(pool: &PgPool, organization: Uuid) -> Result<bool, sqlx::Error> {
    crate::database::organization_detached(pool, organization, async |tx: &mut PgConnection| {
        sqlx::query(PURGE_TX_TIMEOUT).execute(&mut *tx).await?;
        sqlx::query_scalar(&format!(
            "SELECT EXISTS (SELECT 1 FROM operation_receipts WHERE {EXPIRED})"
        ))
        .bind(organization)
        .bind(LIFETIME)
        .fetch_one(tx)
        .await
    })
    .await
}

pub(super) async fn purge(pool: &PgPool, organization: Uuid) -> Result<u64, sqlx::Error> {
    crate::database::organization_detached(pool, organization, async |tx: &mut PgConnection| {
        sqlx::query(PURGE_TX_TIMEOUT)
            .execute(&mut *tx)
            .await?;
        let deleted = sqlx::query(&format!(
            "WITH expired AS MATERIALIZED (\
                SELECT actor, operation_id FROM operation_receipts \
                WHERE {EXPIRED} \
                ORDER BY created_at, actor, operation_id LIMIT {BATCH_ROWS} FOR UPDATE SKIP LOCKED) \
             DELETE FROM operation_receipts r USING expired e \
             WHERE r.organization_id=$1 AND r.actor=e.actor AND r.operation_id=e.operation_id",
        ))
        .bind(organization)
        .bind(LIFETIME)
        .execute(tx)
        .await?;
        Ok(deleted.rows_affected())
    })
    .await
}
