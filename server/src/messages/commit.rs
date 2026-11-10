use uuid::Uuid;

// Hash collisions only serialize unrelated Channels; they cannot expose their data.
pub(super) async fn lock(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    organization: Uuid,
    channel: Uuid,
    shared: bool,
) -> Result<(), sqlx::Error> {
    let sql = if shared {
        "SELECT pg_advisory_xact_lock_shared(hashtextextended($1::uuid::text || '/' || $2::uuid::text, 135))"
    } else {
        "SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text || '/' || $2::uuid::text, 135))"
    };
    sqlx::query(sql)
        .bind(organization)
        .bind(channel)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub(super) async fn finish(
    tx: sqlx::Transaction<'static, sqlx::Postgres>,
    _key: Uuid,
) -> Result<(), sqlx::Error> {
    #[cfg(test)]
    {
        let sender = AMBIGUOUS_COMMITS.lock().unwrap().remove(&_key);
        if let Some(sender) = sender {
            // Model a lost COMMIT response while PostgreSQL still owns the transaction.
            sender.send(tx).unwrap();
            return Err(sqlx::Error::Io(std::io::ErrorKind::ConnectionReset.into()));
        }
    }
    tx.commit().await
}

pub(super) fn definitely_rolled_back(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(|error| error.code())
        .is_some_and(|code| rollback_code(&code))
}

fn rollback_code(code: &str) -> bool {
    // In particular, 40003 (statement_completion_unknown), connection errors and
    // shutdown errors are ambiguous, even when PostgreSQL supplied an error response.
    code.starts_with("23") || matches!(code, "40000" | "40001" | "40002" | "40P01")
}

#[cfg(test)]
type PendingCommit = tokio::sync::oneshot::Sender<sqlx::Transaction<'static, sqlx::Postgres>>;
#[cfg(test)]
static AMBIGUOUS_COMMITS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<Uuid, PendingCommit>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(Default::default()));

#[cfg(test)]
pub(crate) fn ambiguous_commit(
    key: Uuid,
) -> tokio::sync::oneshot::Receiver<sqlx::Transaction<'static, sqlx::Postgres>> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    AMBIGUOUS_COMMITS.lock().unwrap().insert(key, sender);
    receiver
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_rollback_codes_suppress_commit_failure_signals() {
        for code in ["23503", "23514", "40000", "40001", "40002", "40P01"] {
            assert!(rollback_code(code), "{code}");
        }
        for code in ["40003", "08007", "57P01", "58030", "P0001"] {
            assert!(!rollback_code(code), "{code}");
        }
    }
}
