use std::time::Duration;

use sqlx::{PgPool, postgres::types::Oid};

#[derive(Clone, Copy, Debug)]
pub(crate) enum Blocked<'a> {
    LockQuery(&'a str),
    LockQueries(&'a [&'a str]),
    LockQueryBehind(&'a str, i32),
    LockBehind(i32),
    OtherLock,
    Advisory(Advisory<'a>),
    Pid(i32),
    PidLockQuery(i32, &'a str),
    PidEvent(i32, &'a str),
    EventQuery { event: &'a str, query: &'a str },
    Relation(&'a str),
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum Advisory<'a> {
    Query(&'a str),
    Key {
        class_id: Option<u32>,
        object_id: u32,
        current_database: bool,
    },
    SharedBehind(i32),
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum Count {
    AtLeast(i64),
    Exactly(i64),
}

impl Count {
    fn matches(self, actual: i64) -> bool {
        match self {
            Self::AtLeast(minimum) => actual >= minimum,
            Self::Exactly(expected) => actual == expected,
        }
    }
}

impl Blocked<'_> {
    pub(crate) async fn count(self, pool: &PgPool) -> i64 {
        let query = match self {
            Self::LockQuery(pattern) => return count_lock_activity(pool, Some(&[pattern]), None, false).await,
            Self::LockQueries(patterns) => return count_lock_activity(pool, Some(patterns), None, false).await,
            Self::LockQueryBehind(pattern, blocker) => {
                return count_lock_activity(pool, Some(&[pattern]), Some(blocker), false).await;
            }
            Self::LockBehind(blocker) => return count_lock_activity(pool, None, Some(blocker), false).await,
            Self::OtherLock => return count_lock_activity(pool, None, None, true).await,
            Self::Advisory(Advisory::Query(pattern)) => sqlx::query_scalar(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
                 AND wait_event = 'advisory' AND query LIKE $1",
            )
            .bind(pattern),
            Self::Advisory(Advisory::Key {
                class_id,
                object_id,
                current_database,
            }) => sqlx::query_scalar(
                "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
                 AND objid = $1 AND ($2::oid IS NULL OR classid = $2)
                 AND (NOT $3 OR database = (SELECT oid FROM pg_database WHERE datname = current_database()))",
            )
            .bind(Oid(object_id))
            .bind(class_id.map(Oid))
            .bind(current_database),
            Self::Advisory(Advisory::SharedBehind(holder)) => sqlx::query_scalar(
                "SELECT count(*) FROM pg_locks waiter JOIN pg_locks holder
                 USING (locktype, database, classid, objid, objsubid)
                 WHERE holder.pid = $1 AND holder.granted AND waiter.mode = 'ShareLock'
                 AND NOT waiter.granted AND waiter.locktype = 'advisory'",
            )
            .bind(holder),
            Self::Pid(pid) => sqlx::query_scalar(
                "SELECT (cardinality(pg_blocking_pids($1)) > 0)::integer::bigint",
            )
            .bind(pid),
            Self::PidLockQuery(pid, pattern) => sqlx::query_scalar(
                "SELECT count(*) FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'
                 AND query LIKE $2",
            )
            .bind(pid)
            .bind(pattern),
            Self::PidEvent(pid, event) => sqlx::query_scalar(
                "SELECT count(*) FROM pg_stat_activity WHERE pid = $1 AND wait_event = $2",
            )
            .bind(pid)
            .bind(event),
            Self::EventQuery { event, query } => sqlx::query_scalar(
                "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
                 AND wait_event = $1 AND query = $2",
            )
            .bind(event)
            .bind(query),
            Self::Relation(relation) => sqlx::query_scalar(
                "SELECT count(*) FROM pg_locks WHERE NOT granted
                 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                 AND relation = $1::text::regclass",
            )
            .bind(relation),
        };
        query.fetch_one(pool).await.unwrap()
    }
}

async fn count_lock_activity(
    pool: &PgPool,
    patterns: Option<&[&str]>,
    blocker: Option<i32>,
    exclude_self: bool,
) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
         AND wait_event_type = 'Lock' AND ($1::text[] IS NULL OR query LIKE ANY($1))
         AND ($2::integer IS NULL OR $2 = ANY(pg_blocking_pids(pid)))
         AND (NOT $3 OR pid <> pg_backend_pid())",
    )
    .bind(patterns)
    .bind(blocker)
    .bind(exclude_self)
    .fetch_one(pool)
    .await
    .unwrap()
}

pub(crate) async fn wait_blocked(
    pool: &PgPool,
    blocked: Blocked<'_>,
    count: Count,
    timeout: Duration,
) {
    wait_blocked_or(pool, blocked, count, timeout, || false).await;
}

pub(crate) async fn wait_blocked_or(
    pool: &PgPool,
    blocked: Blocked<'_>,
    count: Count,
    timeout: Duration,
    mut done: impl FnMut() -> bool,
) {
    poll_until(timeout, async || {
        (count.matches(blocked.count(pool).await) || done()).then_some(())
    })
    .await
    .unwrap_or_else(|_| panic!("timed out after {timeout:?} waiting for {count:?} {blocked:?}"));
}

pub(crate) async fn eventually(timeout: Duration, mut condition: impl FnMut() -> bool) {
    poll_until(timeout, async || condition().then_some(()))
        .await
        .unwrap_or_else(|_| panic!("condition did not become true within {timeout:?}"));
}

pub(crate) async fn poll_until<T>(
    timeout: Duration,
    mut poll: impl AsyncFnMut() -> Option<T>,
) -> Result<T, tokio::time::error::Elapsed> {
    tokio::time::timeout(timeout, async {
        loop {
            if let Some(value) = poll().await {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
}

#[cfg(test)]
mod tests;
