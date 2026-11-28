use super::{Delivery, MessageError, admission::WORK_TIMEOUT, commit};
use crate::{AppState, database::InternalError};
use sqlx::PgPool;
use uuid::Uuid;

impl Delivery {
    pub(crate) async fn latest_seq(
        &self,
        pool: &PgPool,
        organization: Uuid,
        channel: Uuid,
    ) -> Result<i64, InternalError> {
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
            commit::lock(tx.connection_mut()?, organization, channel, true).await?;
            let sql = "SELECT seq FROM channel_message_sequences \
                       WHERE organization_id = $1 AND channel_id = $2";
            let seq = sqlx::query_scalar::<_, i64>(sql)
                .bind(organization)
                .bind(channel)
                .fetch_optional(tx.connection_mut()?)
                .await?
                .unwrap_or(0);
            tx.commit().await?;
            Ok(seq)
        })
        .await
        .map_err(|_| {
            tracing::warn!(target: "fukulow", event = "work_deadline_expired", operation = "watermark");
            InternalError::Deadline
        })?
    }
}

// Keep HTTP admission rejection distinct from database/barrier work timeouts.
pub(super) async fn read(
    state: &AppState,
    organization: Uuid,
    channel: Uuid,
) -> Result<i64, MessageError> {
    let w = state
        .message_delivery
        .latest_seq(&state.pool, organization, channel)
        .await
        .map_err(projection_error)?;
    #[cfg(test)]
    super::tests::history::pause(channel, "barrier").await;
    Ok(w)
}

fn projection_error(error: InternalError) -> MessageError {
    match error {
        InternalError::Saturated => MessageError::ProjectionAdmissionRejected,
        // Preserve the previous HTTP treatment of an actual driver WouldBlock.
        InternalError::Db(sqlx::Error::Io(error))
            if error.kind() == std::io::ErrorKind::WouldBlock =>
        {
            MessageError::ProjectionAdmissionRejected
        }
        error => error.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::to_bytes,
        http::{StatusCode, header},
        response::IntoResponse,
    };
    use serde_json::json;

    #[tokio::test]
    async fn projection_saturation_retains_503_and_retry_after() {
        let output = crate::observability::tests::Capture::default();
        for error in [
            InternalError::Saturated,
            InternalError::Db(sqlx::Error::Io(std::io::ErrorKind::WouldBlock.into())),
        ] {
            let response = tracing::subscriber::with_default(output.subscriber(), || {
                projection_error(error).into_response()
            });
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            let retry: u64 = response.headers()[header::RETRY_AFTER]
                .to_str()
                .unwrap()
                .parse()
                .unwrap();
            assert!((1..=5).contains(&retry));
            let body = to_bytes(response.into_body(), 1024).await.unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                json!({"error": "projection admission unavailable"})
            );
        }
        assert!(output.events().is_empty());
    }
}
