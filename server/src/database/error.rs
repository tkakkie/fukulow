#[derive(Debug)]
pub enum InternalError {
    Db(sqlx::Error),
    Saturated,
    Deadline,
    Invariant,
    /// A required task stopped or its admission semaphore closed.
    Unavailable,
}

impl From<sqlx::Error> for InternalError {
    fn from(error: sqlx::Error) -> Self {
        Self::Db(error)
    }
}

impl From<tokio::task::JoinError> for InternalError {
    fn from(_: tokio::task::JoinError) -> Self {
        Self::Unavailable
    }
}
