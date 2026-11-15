use super::*;
use crate::observability::tests::Capture;
use futures_util::FutureExt;
use tracing::instrument::WithSubscriber;

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

#[tokio::test(start_paused = true)]
async fn periodic_samples_are_one_second_apart_and_logs_have_only_safe_fields() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://sensitive-user:sensitive-password@127.0.0.1:1/sensitive-db")
        .unwrap();
    pool.close().await;
    let stats = Stats::new();
    assert!(stats.acquire(&pool).await.is_err());
    let output = Capture::default();
    let run = async {
        let report = report(&stats, &pool);
        tokio::pin!(report);
        assert!(report.as_mut().now_or_never().is_none());
        assert!(output.events().is_empty());
        for _ in 0..2 {
            tokio::time::advance(INTERVAL).await;
            assert!(report.as_mut().now_or_never().is_none());
        }
    };
    // Sensitive ambient spans must never enter the aggregate log.
    use tracing::Instrument;
    async {
        let span = tracing::info_span!(target: "fukulow", "request", secret = "sensitive-token");
        run.instrument(span).await;
    }
    .with_subscriber(output.subscriber())
    .await;
    let events = output.events();
    assert_eq!(events.len(), 2);
    for (i, event) in events.iter().enumerate() {
        let fields = event["fields"].as_object().unwrap();
        assert_eq!(fields["event"], "pool_stats");
        assert_eq!(fields["sample_sequence"], i + 1);
        assert_eq!(fields["sample_elapsed_ms"], 1000);
        assert_eq!(fields["occupancy_count"], i + 1);
        assert_eq!(fields["acquire_closed"], 1);
        assert_eq!(fields["wait_count"], 1);
        let mut expected = vec![
            "event",
            "version",
            "coverage",
            "uncovered_paths",
            "interval_ms",
            "sample_sequence",
            "sample_elapsed_ms",
            "in_use",
            "idle",
            "waiting",
            "acquire_success",
            "acquire_timeout",
            "acquire_closed",
            "acquire_io",
            "acquire_database",
            "acquire_other",
            "acquire_cancelled",
            "wait_count",
            "occupancy_count",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
        for edge in [
            100, 500, 1000, 5000, 10000, 25000, 50000, 100000, 500000, 1000000, 5000000,
        ] {
            expected.push(format!("wait_le_{edge}_us"));
        }
        for edge in [0, 1, 2, 4, 8, 16, 24, 32, 48, 64, 100] {
            expected.push(format!("occupancy_le_{edge}"));
        }
        expected.sort();
        let mut actual: Vec<_> = fields.keys().cloned().collect();
        actual.sort();
        assert_eq!(actual, expected);
        assert_eq!(fields["coverage"], "application_after_connect");
        assert_eq!(
            fields["uncovered_paths"],
            "startup_connect,migration_commands"
        );
        for (name, value) in fields {
            if !["event", "coverage", "uncovered_paths"].contains(&name.as_str()) {
                assert!(value.is_u64(), "unexpected field {name}={value}");
            }
        }
        assert_eq!(event["span"], serde_json::json!({"name":"aggregates"}));
    }
    assert!(!output.text().contains("sensitive"));
    assert!(!output.text().contains("SELECT"));
}
