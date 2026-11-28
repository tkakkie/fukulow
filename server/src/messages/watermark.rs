use super::{Delivery, MessageError, admission::WORK_TIMEOUT, commit};
use crate::AppState;
use sqlx::PgPool;
use uuid::Uuid;

impl Delivery {
    pub(crate) async fn latest_seq(
        &self,
        pool: &PgPool,
        organization: Uuid,
        channel: Uuid,
    ) -> Result<i64, sqlx::Error> {
        tokio::time::timeout(WORK_TIMEOUT, async {
            let permit = self
                .admission(pool)
                .acquire(organization, channel, false)
                .await?;
            // A post-failure subscription must not snapshot behind an unresolved COMMIT.
            // Take a fresh READ COMMITTED snapshot *after* acquiring the shared barrier.
            let mut tx =
                commit::Transaction::begin(pool, permit, "BEGIN ISOLATION LEVEL READ COMMITTED", None)
                    .await?;
            commit::lock(tx.connection()?, organization, channel, true).await?;
            let sql = "SELECT seq FROM channel_message_sequences \
                       WHERE organization_id = $1 AND channel_id = $2";
            let seq = sqlx::query_scalar::<_, i64>(sql)
                .bind(organization)
                .bind(channel)
                .fetch_optional(tx.connection()?)
                .await?
                .unwrap_or(0);
            tx.commit().await?;
            Ok(seq)
        })
        .await
        .map_err(|_| {
            tracing::warn!(target: "fukulow", event = "work_deadline_expired", operation = "watermark");
            sqlx::Error::Io(std::io::ErrorKind::TimedOut.into())
        })?
    }
}

// Keep HTTP admission rejection distinct from database/barrier work timeouts.
pub(super) async fn read(
    state: &AppState,
    organization: Uuid,
    channel: Uuid,
) -> Result<i64, MessageError> {
    let w = state.message_delivery.latest_seq(&state.pool, organization, channel).await.map_err(|error| {
        if matches!(&error, sqlx::Error::Io(error) if error.kind() == std::io::ErrorKind::WouldBlock) {
            MessageError::ProjectionAdmissionRejected
        } else {
            MessageError::Database(error)
        }
    })?;
    #[cfg(test)]
    super::tests::history::pause(channel, "barrier").await;
    Ok(w)
}
