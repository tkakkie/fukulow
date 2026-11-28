use super::*;
use futures_util::FutureExt;

#[test]
fn histogram_boundaries_are_inclusive_and_waits_round_up() {
    for edges in [WAIT_US, ACTIVE] {
        for &edge in edges {
            for value in [edge.saturating_sub(1), edge, edge.saturating_add(1)] {
                let histogram = Histogram::new(edges);
                histogram.record(edges, value);
                let actual = histogram.cumulative();
                let expected: Vec<_> = edges
                    .iter()
                    .map(|bound| u64::from(value <= *bound))
                    .collect();
                assert_eq!(actual, expected, "edge={edge} value={value}");
            }
        }
    }
    assert!(WAIT_US.contains(&10_000) && WAIT_US.contains(&50_000));
    assert!(ACTIVE.contains(&24) && ACTIVE.contains(&32));
    assert_eq!(wait_us(Duration::from_nanos(10_000_001)), 10_001);
    assert_eq!(wait_us(Duration::from_millis(50)), 50_000);
    assert_eq!(wait_us(Duration::MAX), u64::MAX);
}

#[fukulow_test::test]
async fn forced_timeout_cancellation_and_held_occupancy_are_counted(pool: PgPool) {
    let single = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(1))
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    let stats = Stats::new();
    let held = stats.acquire(&single).await.unwrap();
    assert_eq!(stats.sample(&single), (1, 0));
    assert!(matches!(
        stats.acquire(&single).await,
        Err(sqlx::Error::PoolTimedOut)
    ));
    assert_eq!(stats.timeout.load(Relaxed), 1);
    // Poll the acquisition before dropping it; no sleep/race needed.
    let mut pending = Box::pin(stats.acquire(&single));
    assert!(pending.as_mut().now_or_never().is_none());
    assert_eq!(stats.waiting.load(Relaxed), 1);
    drop(pending);
    assert_eq!(stats.cancelled.load(Relaxed), 1);
    assert_eq!(stats.waiting.load(Relaxed), 0);
    assert_eq!(stats.wait.cumulative().last(), Some(&3));
    drop(held);
    single.close().await;
    assert!(matches!(
        stats.acquire(&single).await,
        Err(sqlx::Error::PoolClosed)
    ));
    assert_eq!(stats.closed.load(Relaxed), 1);
}
