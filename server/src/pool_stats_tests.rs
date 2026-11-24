use crate::{database, observability::tests::Capture};
use futures_util::FutureExt;
use std::time::Duration;
use tracing::instrument::WithSubscriber;

#[tokio::test(start_paused = true)]
async fn periodic_samples_are_one_second_apart_and_logs_have_only_safe_fields() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://sensitive-user:sensitive-password@127.0.0.1:1/sensitive-db")
        .unwrap();
    pool.close().await;
    database::test_acquisitions(async {
        assert!(database::acquire(&pool).await.is_err());
        let output = Capture::default();
        let run = async {
            let report = database::report_pool_periodically(pool);
            tokio::pin!(report);
            assert!(report.as_mut().now_or_never().is_none());
            assert!(output.events().is_empty());
            for _ in 0..2 {
                tokio::time::advance(Duration::from_secs(1)).await;
                assert!(report.as_mut().now_or_never().is_none());
            }
        };
        // Sensitive ambient spans must never enter the aggregate log.
        use tracing::Instrument;
        async {
            let span =
                tracing::info_span!(target: "fukulow", "request", secret = "sensitive-token");
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
    })
    .await;
}
