use super::*;
use crate::channels::activity::{self, Activity, ChangeScope, Notice, Role};
use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll, Waker},
    time::Duration,
};
use tokio::time::{advance, timeout};

fn pool() -> sqlx::PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect_lazy_with(sqlx::postgres::PgConnectOptions::new())
}

fn budget(record: bool) -> (OnceLock<NoticeBudget>, Arc<NoticePermitGauges>) {
    let gauges = Arc::<NoticePermitGauges>::default();
    let budget = NoticeBudget::new(1, record.then(|| gauges.clone()));
    (OnceLock::from(budget), gauges)
}

fn poll<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    future.poll(&mut Context::from_waker(Waker::noop()))
}

fn ready<'a>(result: Poll<Result<NoticePermit<'a>, sqlx::Error>>) -> NoticePermit<'a> {
    match result {
        Poll::Ready(Ok(permit)) => permit,
        _ => panic!("permit was not granted"),
    }
}

#[tokio::test(start_paused = true)]
async fn notice_permits_grant_in_fifo_order_with_and_without_gauges() {
    async fn grant_order(record: bool) -> Vec<usize> {
        let pool = pool();
        let (budget, gauges) = budget(record);
        let mut held = notice_query_slot(&budget, &pool, NoticeCaller::Handoff)
            .await
            .unwrap();
        let mut waiters: Vec<_> = (0..8)
            .map(|_| {
                Some(Box::pin(notice_query_slot(
                    &budget,
                    &pool,
                    NoticeCaller::Retry,
                )))
            })
            .collect();
        for waiter in waiters.iter_mut().flatten() {
            assert!(poll(waiter.as_mut()).is_pending());
        }
        assert_eq!(
            gauges.caller(NoticeCaller::Retry).waiting.load(Relaxed),
            if record { 8 } else { 0 }
        );
        let mut order = Vec::new();
        // Poll backwards so a waiter that was never enqueued can steal the first grant.
        for _ in 0..8 {
            drop(held);
            let mut next = None;
            for (i, waiter) in waiters.iter_mut().enumerate().rev() {
                if let Some(future) = waiter
                    && let Poll::Ready(result) = poll(future.as_mut())
                {
                    assert!(next.is_none(), "more than one grant for a single permit");
                    next = Some(result.unwrap());
                    *waiter = None;
                    order.push(i);
                }
            }
            held = next.unwrap();
        }
        assert_eq!(gauges.caller(NoticeCaller::Retry).waiting.load(Relaxed), 0);
        order
    }

    let measured = grant_order(true).await;
    assert_eq!(measured, grant_order(false).await);
    assert_eq!(measured, (0..8).collect::<Vec<_>>());
}

#[tokio::test(start_paused = true)]
async fn abandoned_waiter_keeps_fifo_order_of_the_rest() {
    let pool = pool();
    let (budget, gauges) = budget(true);
    let held = notice_query_slot(&budget, &pool, NoticeCaller::Handoff)
        .await
        .unwrap();
    let mut first = std::pin::pin!(notice_query_slot(&budget, &pool, NoticeCaller::Retry));
    let mut middle = Box::pin(timeout(
        Duration::from_millis(50),
        notice_query_slot(&budget, &pool, NoticeCaller::Retry),
    ));
    let mut last = std::pin::pin!(notice_query_slot(&budget, &pool, NoticeCaller::Retry));
    assert!(poll(first.as_mut()).is_pending());
    assert!(poll(middle.as_mut()).is_pending());
    assert!(poll(last.as_mut()).is_pending());
    advance(Duration::from_millis(50)).await;
    assert!(middle.as_mut().await.is_err());
    drop(middle);
    drop(held);
    assert!(poll(last.as_mut()).is_pending());
    let held = ready(poll(first.as_mut()));
    assert!(poll(last.as_mut()).is_pending());
    drop(held);
    drop(ready(poll(last.as_mut())));
    let retry = gauges.caller(NoticeCaller::Retry);
    assert_eq!(retry.waiting.load(Relaxed), 0);
    assert_eq!(retry.wait_abandoned.load(Relaxed), 1);
}

#[tokio::test(start_paused = true)]
async fn available_permit_is_granted_on_first_poll() {
    let pool = pool();
    let (budget, _) = budget(true);
    let mut acquire = std::pin::pin!(notice_query_slot(&budget, &pool, NoticeCaller::Publish));
    drop(ready(poll(acquire.as_mut())));
}

#[tokio::test(start_paused = true)]
async fn gauges_track_waiting_holding_and_checkout_per_caller() {
    let pool = pool();
    let (budget, gauges) = budget(true);
    let holder = notice_query_slot(&budget, &pool, NoticeCaller::Retry)
        .await
        .unwrap();
    let checkout = holder.checkout().unwrap();
    let mut waiter = Box::pin(notice_query_slot(&budget, &pool, NoticeCaller::Publish));
    assert!(poll(waiter.as_mut()).is_pending());
    let retry = gauges.caller(NoticeCaller::Retry);
    let publish = gauges.caller(NoticeCaller::Publish);
    assert_eq!(retry.holding.load(Relaxed), 1);
    assert_eq!(retry.holding_checked_out.load(Relaxed), 1);
    assert_eq!(publish.waiting.load(Relaxed), 1);
    assert_eq!(publish.holding.load(Relaxed), 0);
    drop(checkout);
    drop(holder);
    drop(ready(poll(waiter.as_mut())));
    for caller in [retry, publish] {
        assert_eq!(caller.waiting.load(Relaxed), 0);
        assert_eq!(caller.holding.load(Relaxed), 0);
        assert_eq!(caller.holding_checked_out.load(Relaxed), 0);
    }
}

#[tokio::test(start_paused = true)]
async fn guards_decrement_and_count_time_on_cancellation() {
    let pool = pool();
    let (budget, gauges) = budget(true);
    let elapsed = Duration::from_millis(7);
    let holder = notice_query_slot(&budget, &pool, NoticeCaller::Retry)
        .await
        .unwrap();
    let mut waiter = Box::pin(notice_query_slot(&budget, &pool, NoticeCaller::Publish));
    assert!(poll(waiter.as_mut()).is_pending());
    advance(elapsed).await;
    drop(waiter);
    drop(holder);

    let mut statement = Box::pin(async {
        let holder = notice_query_slot(&budget, &pool, NoticeCaller::Retry)
            .await
            .unwrap();
        let _checkout = holder.checkout();
        std::future::pending::<()>().await;
    });
    let mut all_pass = Box::pin(async {
        let _guard = NoticeBudget::all_pass(&budget);
        std::future::pending::<()>().await;
    });
    assert!(poll(statement.as_mut()).is_pending());
    assert!(poll(all_pass.as_mut()).is_pending());
    advance(elapsed).await;
    drop(statement);
    drop(all_pass);

    let retry = gauges.caller(NoticeCaller::Retry);
    let publish = gauges.caller(NoticeCaller::Publish);
    assert_eq!(publish.waiting.load(Relaxed), 0);
    assert_eq!(publish.wait_abandoned_us_total.load(Relaxed), 7_000);
    assert_eq!(retry.holding.load(Relaxed), 0);
    assert_eq!(retry.holding_checked_out.load(Relaxed), 0);
    assert_eq!(retry.hold_us_total.load(Relaxed), 14_000);
    assert_eq!(retry.pool_wait_us_total.load(Relaxed), 7_000);
    assert_eq!(retry.statement_us_total.load(Relaxed), 7_000);
    assert_eq!(gauges.all_pass_in_flight.load(Relaxed), 0);
    assert_eq!(gauges.all_pass_statements.load(Relaxed), 1);
    assert_eq!(gauges.all_pass_us_total.load(Relaxed), 7_000);
}

#[tokio::test(start_paused = true)]
async fn hold_total_matches_pool_wait_plus_statement() {
    let pool = pool();
    let (budget, gauges) = budget(true);
    let held = notice_query_slot(&budget, &pool, NoticeCaller::Retry)
        .await
        .unwrap();
    advance(Duration::from_millis(8)).await;
    let checkout = held.checkout().unwrap();
    advance(Duration::from_millis(13)).await;
    drop(checkout);
    drop(held);
    let retry = gauges.caller(NoticeCaller::Retry);
    assert_eq!(retry.hold_us_total.load(Relaxed), 21_000);
    assert_eq!(
        retry.pool_wait_us_total.load(Relaxed) + retry.statement_us_total.load(Relaxed),
        21_000
    );
}

#[tokio::test(start_paused = true)]
async fn wait_histogram_buckets_paused_time() {
    let pool = pool();
    let (budget, gauges) = budget(true);
    for (ms, abandon) in [(0, false), (7, false), (300, true), (6000, false)] {
        let holder = notice_query_slot(&budget, &pool, NoticeCaller::Scoped)
            .await
            .unwrap();
        let mut waiter = Box::pin(notice_query_slot(&budget, &pool, NoticeCaller::Retry));
        assert!(poll(waiter.as_mut()).is_pending());
        advance(Duration::from_millis(ms)).await;
        if abandon {
            drop(waiter);
            drop(holder);
        } else {
            drop(holder);
            drop(ready(poll(waiter.as_mut())));
        }
    }
    let retry = gauges.caller(NoticeCaller::Retry);
    assert_eq!(retry.granted.load(Relaxed), 3);
    assert_eq!(retry.wait_abandoned.load(Relaxed), 1);
    assert_eq!(retry.wait_granted_us_total.load(Relaxed), 6_007_000);
    assert_eq!(retry.wait_abandoned_us_total.load(Relaxed), 300_000);
    assert_eq!(
        gauges.cumulative_waits(NoticeCaller::Retry),
        [1, 1, 2, 2, 2, 2, 3, 3, 3, 3]
    );
}

#[tokio::test(start_paused = true)]
async fn recording_off_leaves_gauges_zero() {
    let pool = pool();
    let (budget, gauges) = budget(false);
    let holder = notice_query_slot(&budget, &pool, NoticeCaller::Retry)
        .await
        .unwrap();
    assert!(holder.checkout().is_none());
    assert!(NoticeBudget::all_pass(&budget).is_none());
    drop(holder);
    let retry = gauges.caller(NoticeCaller::Retry);
    assert_eq!(retry.granted.load(Relaxed), 0);
    assert_eq!(retry.hold_us_total.load(Relaxed), 0);
    assert_eq!(gauges.cumulative_waits(NoticeCaller::Retry), [0; 10]);
    assert_eq!(gauges.permits_total.load(Relaxed), 0);
}

#[tokio::test(start_paused = true)]
async fn closed_semaphore_wait_is_abandoned() {
    let pool = pool();
    let (budget, gauges) = budget(true);
    budget.get().unwrap().semaphore.close();
    assert!(matches!(
        notice_query_slot(&budget, &pool, NoticeCaller::Retry).await,
        Err(sqlx::Error::PoolClosed)
    ));
    let retry = gauges.caller(NoticeCaller::Retry);
    assert_eq!(retry.waiting.load(Relaxed), 0);
    assert_eq!(retry.wait_abandoned.load(Relaxed), 1);
    assert_eq!(retry.granted.load(Relaxed), 0);
}

fn activity_fixture() -> (Activity, Arc<activity::Entry>, Arc<NoticePermitGauges>) {
    let (budget, gauges) = budget(true);
    let activity = Activity {
        notice_queries: Arc::new(budget),
        ..Activity::default()
    };
    let mut entry = activity::tests::entry();
    Arc::get_mut(&mut entry).unwrap().notice_queries = activity.notice_queries.clone();
    activity
        .entries
        .lock()
        .unwrap()
        .insert(entry.id, entry.clone());
    (activity, entry, gauges)
}

#[fukulow_test::test]
async fn all_pass_bypasses_permit_gauges(pool: sqlx::PgPool) {
    let (activity, entry, gauges) = activity_fixture();
    let channel = uuid::Uuid::new_v4();
    let _capture = entry
        .buffer
        .lock()
        .unwrap()
        .revocations
        .capture(ChangeScope::Channel(channel))
        .notice(channel, false, Role::Member)
        .unwrap();
    let gate = activity::pause_member(
        entry.organization,
        channel,
        "notice_statement",
        Some(entry.member.0),
    );
    let work = activity.check(&pool, crate::auth::SubscriptionScope::All);
    let mut work = std::pin::pin!(work);
    tokio::select! {
        _ = gate.entered() => {}
        _ = &mut work => panic!("All check finished without entering the statement"),
    }
    assert_eq!(gauges.all_pass_in_flight.load(Relaxed), 1);
    for caller in [
        NoticeCaller::Retry,
        NoticeCaller::Handoff,
        NoticeCaller::Publish,
        NoticeCaller::Revoked,
        NoticeCaller::Scoped,
    ] {
        let counters = gauges.caller(caller);
        assert_eq!(counters.holding.load(Relaxed), 0);
        assert_eq!(counters.holding_checked_out.load(Relaxed), 0);
        assert_eq!(counters.granted.load(Relaxed), 0);
    }
    gate.release();
    work.await;
    assert_eq!(gauges.all_pass_in_flight.load(Relaxed), 0);
    assert_eq!(gauges.all_pass_statements.load(Relaxed), 1);
}

#[fukulow_test::test]
async fn callers_are_tagged(pool: sqlx::PgPool) {
    let (activity, entry, gauges) = activity_fixture();
    let channel = uuid::Uuid::new_v4();
    let totals = || {
        [
            NoticeCaller::Retry,
            NoticeCaller::Handoff,
            NoticeCaller::Publish,
            NoticeCaller::Revoked,
            NoticeCaller::Scoped,
        ]
        .map(|caller| gauges.caller(caller).granted.load(Relaxed))
    };
    activity
        .publish(
            &pool,
            entry.organization,
            Notice::ChannelMembersChanged {
                channel_id: channel,
            },
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(totals(), [0, 0, 1, 0, 0]);
    let mutation = entry
        .buffer
        .lock()
        .unwrap()
        .revocations
        .capture(ChangeScope::Channel(channel));
    // Keep the mutation capture live through the revocation rechecks.
    let _change = activity
        .revoked_for_test(&pool, &entry, channel, mutation)
        .await
        .unwrap();
    assert_eq!(totals(), [0, 0, 1, 1, 0]);

    let capture_revocation = || {
        entry
            .buffer
            .lock()
            .unwrap()
            .revocations
            .capture(ChangeScope::Channel(channel))
            .notice(channel, false, Role::Member)
            .unwrap()
    };
    let capture = capture_revocation();
    activity
        .check(
            &pool,
            crate::auth::SubscriptionScope::Member(entry.organization, entry.member.0),
        )
        .await;
    assert_eq!(totals(), [0, 0, 1, 1, 1]);

    for (retry, expected) in [(false, [0, 1, 1, 1, 1]), (true, [1, 1, 1, 1, 1])] {
        let capture = capture_revocation();
        let check = capture.check().unwrap();
        let frame = activity::NoticeFrame {
            entry: entry.clone(),
            epoch: activity::Epoch::Revocation(capture),
            directory_epoch: None,
            event: Notice::ChannelAccessRevoked {
                channel_id: channel,
            },
            valid: Arc::new(activity::QueryToken::new()),
            recovery: None,
            retry,
        };
        assert!(
            frame
                .recheck_revocation(
                    &pool,
                    check,
                    tokio::time::Instant::now() + Duration::from_secs(5),
                    None
                )
                .await
                .is_ok()
        );
        assert_eq!(totals(), expected);
    }
    drop(capture);
}
