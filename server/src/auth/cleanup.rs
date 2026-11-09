use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use sqlx::PgPool;
use tokio::time::Instant;
use uuid::Uuid;

const INTERVAL: Duration = Duration::from_secs(60);
const BATCH_SIZE: i64 = 1_000;

/// One cleanup attempt per interval across all Organizations served by this process.
#[derive(Clone, Default)]
pub struct SessionCleanup(Arc<Mutex<Option<Instant>>>);

impl SessionCleanup {
    pub(super) async fn run(&self, pool: &PgPool, organization: Uuid) {
        {
            let mut last = self.0.lock().unwrap_or_else(|poison| poison.into_inner());
            let now = Instant::now();
            if last.is_some_and(|last| now.duration_since(last) < INTERVAL) {
                return;
            }
            // Reserve before awaiting SQL, including failed or cancelled attempts.
            *last = Some(now);
        }
        let result = tokio::time::timeout(Duration::from_secs(2), async {
            let mut tx = pool.begin().await?;
            // Bound lock waits and SQL work as well as the number of deleted rows.
            sqlx::query("SET LOCAL statement_timeout = '1s'")
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "DELETE FROM sessions WHERE organization_id = $1 AND token_hash IN (\
                 SELECT token_hash FROM sessions \
                 WHERE organization_id = $1 AND expires_at <= now() \
                 ORDER BY expires_at, token_hash LIMIT $2 FOR UPDATE SKIP LOCKED)",
            )
            .bind(organization)
            .bind(BATCH_SIZE)
            .execute(&mut *tx)
            .await?;
            tx.commit().await
        })
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => eprintln!("expired-session cleanup failed: {error}"),
            Err(error) => eprintln!("expired-session cleanup timed out: {error}"),
        }
    }
}
