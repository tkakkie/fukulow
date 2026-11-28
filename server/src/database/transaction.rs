use sqlx::{PgConnection, PgPool, Postgres, pool::PoolConnection};

pub async fn read_only<T, E>(
    pool: &PgPool,
    body: impl AsyncFnOnce(&mut PgConnection) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<sqlx::Error>,
{
    transaction(pool, Access::Snapshot, Discard::Close, |_| false, body).await
}

pub(super) enum Access {
    ReadWrite,
    Snapshot,
}

pub(super) enum Discard {
    Close,
    Detach,
}

pub(super) async fn transaction<T, E>(
    pool: &PgPool,
    access: Access,
    discard: Discard,
    confirm_rollback: fn(&E) -> bool,
    body: impl AsyncFnOnce(&mut PgConnection) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<sqlx::Error>,
{
    let mut guard = TransactionConnection::new(discard);
    let connection = guard
        .connection
        .insert(crate::database::acquire(pool).await?);
    // SQLx 0.8.6 records transaction depth only after BEGIN's response, so its
    // rollback-on-drop cannot recover a BEGIN cancelled before that response.
    sqlx::Executor::execute(
        &mut **connection,
        match access {
            Access::Snapshot => "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
            Access::ReadWrite => "BEGIN",
        },
    )
    .await?;
    let result = body(connection).await;
    // Read snapshots always roll back; writes commit only a successful body.
    let end = if matches!(access, Access::ReadWrite) && result.is_ok() {
        "COMMIT"
    } else {
        "ROLLBACK"
    };
    let finished = sqlx::Executor::execute(&mut **connection, end).await;
    guard.finished = finished.is_ok();
    // Preserve body errors unless the caller requires a confirmed rollback for
    // that error. The armed guard discards the connection on cleanup failure.
    match (result, finished) {
        (Err(body), Err(cleanup)) if confirm_rollback(&body) => Err(cleanup.into()),
        (Err(body), _) => Err(body),
        (Ok(value), finished) => {
            finished?;
            Ok(value)
        }
    }
}

pub(super) struct TransactionConnection {
    pub(super) connection: Option<PoolConnection<Postgres>>,
    pub(super) finished: bool,
    discard: Discard,
}

impl TransactionConnection {
    pub(super) fn new(discard: Discard) -> Self {
        Self {
            connection: None,
            finished: false,
            discard,
        }
    }
}

impl Drop for TransactionConnection {
    fn drop(&mut self) {
        if !self.finished
            && let Some(mut connection) = self.connection.take()
        {
            match self.discard {
                Discard::Close => connection.close_on_drop(),
                // SQLx graceful close can retain the permit for five seconds.
                // Deadline-bound workers must free it synchronously instead.
                Discard::Detach => drop(connection.detach()),
            }
        }
    }
}
