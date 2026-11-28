use sqlx::{PgPool, Postgres, pool::PoolConnection};

const READY_ACQUIRE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(200);
const READY_QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(200);
const READY_RETURN_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(200);

pub(crate) async fn ready(pool: &PgPool) -> bool {
    let mut guard = ReadyConnection(None);
    let Ok(Ok(connection)) =
        tokio::time::timeout(READY_ACQUIRE_TIMEOUT, crate::database::acquire(pool)).await
    else {
        return false;
    };
    let connection = guard.0.insert(connection);
    if !matches!(
        tokio::time::timeout(
            READY_QUERY_TIMEOUT,
            sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&mut **connection),
        )
        .await,
        Ok(Ok(1))
    ) {
        return false;
    }
    let Some(mut connection) = guard.0.take() else {
        return false;
    };
    // SQLx moves the socket and pool permit into this future synchronously.
    // Dropping it on timeout/cancellation closes the socket and frees the permit;
    // PoolConnection::Drop would instead spawn an unbounded return ping.
    tokio::time::timeout(READY_RETURN_TIMEOUT, connection.return_to_pool())
        .await
        .is_ok()
}

struct ReadyConnection(Option<PoolConnection<Postgres>>);

impl Drop for ReadyConnection {
    fn drop(&mut self) {
        if let Some(connection) = self.0.take() {
            // Includes errors and cancellation while SELECT 1 is in flight.
            drop(connection.detach());
        }
    }
}
