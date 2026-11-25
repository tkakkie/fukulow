use super::*;

const DEADLINE: Duration = Duration::from_secs(5);

#[test]
fn count_rules_distinguish_under_exact_and_over() {
    assert!(!Count::AtLeast(2).matches(1));
    assert!(Count::AtLeast(2).matches(2));
    assert!(Count::AtLeast(2).matches(3));
    assert!(!Count::Exactly(2).matches(1));
    assert!(Count::Exactly(2).matches(2));
    assert!(!Count::Exactly(2).matches(3));
}

#[sqlx::test(migrations = false)]
async fn counts_lock_queries_advisory_waits_and_pids(pool: PgPool) {
    let mut blocker = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(847, 1)")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let holder: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();

    let statement = "SELECT pg_advisory_xact_lock_shared(847, 1)";
    let mut waiters = Vec::new();
    for _ in 0..2 {
        let mut waiter = pool.acquire().await.unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *waiter)
            .await
            .unwrap();
        waiters.push(tokio::spawn(async move {
            sqlx::query(statement).execute(&mut *waiter).await.unwrap();
        }));
        wait_blocked(&pool, Blocked::Pid(pid), Count::Exactly(1), DEADLINE).await;
        wait_blocked(
            &pool,
            Blocked::PidEvent(pid, "advisory"),
            Count::Exactly(1),
            DEADLINE,
        )
        .await;
        wait_blocked(
            &pool,
            Blocked::PidLockQuery(pid, statement),
            Count::Exactly(1),
            DEADLINE,
        )
        .await;
    }

    for blocked in [
        Blocked::LockQuery("SELECT pg_advisory_xact_lock_shared(847,%"),
        Blocked::LockQueries(&[statement, "SELECT pg_advisory_xact_lock_shared%"]),
        Blocked::LockQueryBehind(statement, holder),
        Blocked::LockBehind(holder),
        Blocked::OtherLock,
        Blocked::EventQuery {
            event: "advisory",
            query: statement,
        },
        Blocked::Advisory(Advisory::Query(statement)),
        Blocked::Advisory(Advisory::SharedBehind(holder)),
        Blocked::Advisory(Advisory::Key {
            class_id: Some(847),
            object_id: 1,
            current_database: true,
        }),
    ] {
        wait_blocked(&pool, blocked, Count::AtLeast(1), DEADLINE).await;
        wait_blocked(&pool, blocked, Count::Exactly(2), DEADLINE).await;
    }
    assert_eq!(
        Blocked::LockQuery("SELECT unrelated%").count(&pool).await,
        0
    );
    assert_eq!(Blocked::Pid(holder).count(&pool).await, 0);

    blocker.rollback().await.unwrap();
    for waiter in waiters {
        tokio::time::timeout(DEADLINE, waiter)
            .await
            .unwrap()
            .unwrap();
    }
}

#[sqlx::test(migrations = false)]
async fn counts_only_ungranted_locks_on_the_relation(pool: PgPool) {
    sqlx::raw_sql("CREATE TABLE lock_probe (); CREATE TABLE other_probe ()")
        .execute(&pool)
        .await
        .unwrap();
    let mut blocker = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE lock_probe, other_probe IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *blocker)
        .await
        .unwrap();

    let waiter_pool = pool.clone();
    let waiter = tokio::spawn(async move {
        sqlx::query("SELECT * FROM lock_probe")
            .execute(&waiter_pool)
            .await
            .unwrap();
    });
    wait_blocked(
        &pool,
        Blocked::Relation("lock_probe"),
        Count::Exactly(1),
        DEADLINE,
    )
    .await;
    assert_eq!(Blocked::Relation("other_probe").count(&pool).await, 0);
    blocker.rollback().await.unwrap();
    tokio::time::timeout(DEADLINE, waiter)
        .await
        .unwrap()
        .unwrap();
}

#[sqlx::test(migrations = false)]
async fn wait_blocked_fails_on_timeout(pool: PgPool) {
    use futures_util::FutureExt;
    use std::panic::AssertUnwindSafe;

    let failure = AssertUnwindSafe(wait_blocked(
        &pool,
        Blocked::Pid(0),
        Count::AtLeast(1),
        Duration::from_millis(25),
    ))
    .catch_unwind()
    .await
    .unwrap_err();
    let message = failure.downcast::<String>().unwrap();
    assert!(message.contains("waiting for AtLeast(1) Pid(0)"));
}

#[tokio::test(start_paused = true)]
async fn eventually_rechecks_the_condition() {
    let mut polls = 0;
    eventually(DEADLINE, || {
        polls += 1;
        polls == 2
    })
    .await;
    assert_eq!(polls, 2);
}

#[tokio::test(start_paused = true)]
#[should_panic(expected = "condition did not become true within")]
async fn eventually_fails_on_timeout() {
    eventually(Duration::from_millis(20), || false).await;
}
