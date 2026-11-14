use super::*;
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    middleware,
    routing::post,
};
use serde_json::Value;
use std::{
    io::{self, Write},
    sync::{Arc, Mutex},
};
use tower::ServiceExt;
use tracing::instrument::WithSubscriber;

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);
impl Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = Self;
    fn make_writer(&'a self) -> Self {
        self.clone()
    }
}
impl Capture {
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }
    fn events(&self) -> Vec<Value> {
        self.text()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
}

#[tokio::test]
async fn request_spans_redact_secrets_and_use_templates_and_generated_ids() {
    let output = Capture::default();
    async {
        let app = Router::new()
            .route("/objects/{id}", post(|| async {
                // Dependency diagnostics must stay disabled even at ERROR.
                tracing::error!(target: "sqlx::query", sql = "secret-sql-parameter");
                database_failure(&sqlx::Error::Protocol("secret-error-detail".into()));
                StatusCode::INTERNAL_SERVER_ERROR
            }))
            .fallback(|| async { StatusCode::NOT_FOUND })
            .layer(middleware::from_fn(request));
        for path in ["/objects/secret-path?token=secret-query", "/secret-fallback?token=secret-query"] {
            let response = app.clone().oneshot(Request::builder().method("POST").uri(path)
                .header("cookie", "secret-cookie")
                .header("authorization", "Bearer secret-bearer")
                .header("x-request-id", "secret-inbound-id")
                .header("x-setup-token", "secret-setup-header")
                .body(Body::from(r#"{"password":"secret-password","setup_token":"secret-setup","invite_token":"secret-invite","body":"secret-message"}"#)).unwrap()).await.unwrap();
            assert!(response.status().is_client_error() || response.status().is_server_error());
        }
        // Extension methods are arbitrary input and must not become log fields.
        let _ = app.oneshot(Request::builder().method("secret-method").uri("/objects/secret-path")
            .body(Body::empty()).unwrap()).await.unwrap();
    }.with_subscriber(subscriber(output.clone())).await;
    assert!(!output.text().contains("secret-"), "{}", output.text());
    let events = output.events();
    let requests: Vec<_> = events
        .iter()
        .filter(|e| e["fields"]["event"] == "http_completed")
        .collect();
    assert_eq!(requests.len(), 3);
    let mut ids = std::collections::HashSet::new();
    for (index, event) in requests.iter().enumerate() {
        let span = &event["span"];
        assert!(ids.insert(uuid::Uuid::parse_str(span["request_id"].as_str().unwrap()).unwrap()));
        assert_eq!(
            span["route"],
            if index == 1 {
                "<unmatched>"
            } else {
                "/objects/{id}"
            }
        );
        assert_eq!(span["method"], if index == 2 { "OTHER" } else { "POST" });
        assert_eq!(span["status"], [500, 404, 405][index]);
        assert!(span["duration_ms"].as_f64().unwrap() >= 0.0);
        assert_eq!(span.as_object().unwrap().len(), 6);
    }
    assert_eq!(events[0]["fields"]["event"], "database_failure");
    assert_eq!(
        events[0]["span"]["request_id"],
        requests[0]["span"]["request_id"]
    );
}

#[derive(Debug)]
struct SensitiveDatabaseError;
impl std::fmt::Display for SensitiveDatabaseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("secret-display")
    }
}
impl std::error::Error for SensitiveDatabaseError {}
impl sqlx::error::DatabaseError for SensitiveDatabaseError {
    fn message(&self) -> &str {
        "secret-message"
    }
    fn code(&self) -> Option<std::borrow::Cow<'_, str>> {
        Some("secret-code".into())
    }
    fn constraint(&self) -> Option<&str> {
        Some("secret-constraint")
    }
    fn table(&self) -> Option<&str> {
        Some("secret-table")
    }
    fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
        self
    }
    fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
        self
    }
    fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
        self
    }
    fn kind(&self) -> sqlx::error::ErrorKind {
        sqlx::error::ErrorKind::Other
    }
}

#[test]
fn database_errors_never_format_sensitive_details_or_sources() {
    let output = Capture::default();
    tracing::subscriber::with_default(subscriber(output.clone()), || {
        for error in [
            sqlx::Error::Database(Box::new(SensitiveDatabaseError)),
            sqlx::Error::Configuration(Box::new(io::Error::other("secret-configuration"))),
            sqlx::Error::Io(io::Error::other(
                "secret-cookie-bearer-password-setup-invite-body",
            )),
            sqlx::Error::Protocol("secret-protocol".into()),
            sqlx::Error::PoolTimedOut,
            sqlx::Error::PoolClosed,
            sqlx::Error::Io(io::Error::new(io::ErrorKind::TimedOut, "secret-deadline")),
            sqlx::Error::Io(io::Error::new(
                io::ErrorKind::WouldBlock,
                "secret-admission",
            )),
        ] {
            database_failure(&error);
        }
    });
    let text = output.text();
    assert!(!text.contains("secret"), "{text}");
    assert!(!text.contains("SensitiveDatabaseError"));
    let kinds: Vec<_> = output
        .events()
        .into_iter()
        .map(|e| e["fields"]["kind"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        kinds,
        [
            "database",
            "other",
            "io",
            "other",
            "pool_timeout",
            "pool_closed",
            "deadline"
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn aggregates_have_fixed_cardinality_and_admission_flood_is_silent() {
    let output = Capture::default();
    async {
        let metrics = Metrics::new();
        for kind in Admission::ALL {
            for _ in 0..10_000 { metrics.reject(kind); }
        }
        for code in 0..=u16::MAX {
            let (index, _) = close_bucket(Some(code));
            metrics.closes[index].fetch_add(1, Relaxed);
        }
        assert!(output.text().is_empty());
        let reporter = report_metrics(&metrics).instrument(tracing::info_span!(target: TARGET, "request", request_id = "secret-correlation"));
        tokio::pin!(reporter);
        tokio::select! { _ = &mut reporter => unreachable!(), _ = tokio::time::sleep(INTERVAL - Duration::from_millis(1)) => {} }
        assert!(output.text().is_empty());
        tokio::select! { _ = &mut reporter => unreachable!(), _ = tokio::time::sleep(Duration::from_millis(2)) => {} }
        let events = output.events();
        assert!(!output.text().contains("secret-correlation"));
        assert_eq!(events.len(), 13);
        assert_eq!(events[0]["fields"]["admission_rejections"], 120_000);
        assert_eq!(events[0]["fields"]["close_1011"], 1);
        assert_eq!(events[0]["fields"]["close_4008"], 1);
        assert_eq!(events[0]["fields"]["close_other"], 65_530);
        for (event, kind) in events[1..].iter().zip(Admission::ALL) {
            assert_eq!(event["fields"], serde_json::json!({"event":"admission_rejected", "kind":kind.name(), "count":10_000}));
            assert_eq!(event["span"], serde_json::json!({"name":"aggregates"}));
        }
        let fields = events[0]["fields"].as_object().unwrap();
        assert_eq!(fields.len(), 12);
        assert!(fields.keys().all(|key| ["event", "interval_seconds", "active_websockets", "close_1001", "close_1011", "close_4001", "close_4003", "close_4008", "close_4029", "close_other", "peer_or_transport_end", "admission_rejections"].contains(&key.as_str())));
    }.with_subscriber(subscriber(output.clone())).await;
}

#[tokio::test]
async fn active_socket_guard_releases_on_cancellation_and_normal_exit() {
    let metrics = Metrics::new();
    let guard = metrics.socket();
    assert_eq!(metrics.active.load(Relaxed), 1);
    drop(guard);
    assert_eq!(metrics.active.load(Relaxed), 0);
    let pending = async {
        let _guard = metrics.socket();
        std::future::pending::<()>().await;
    };
    assert!(
        tokio::time::timeout(Duration::from_millis(1), pending)
            .await
            .is_err()
    );
    assert_eq!(metrics.active.load(Relaxed), 0);
}

#[test]
fn socket_close_counters_and_lifecycle_logs_use_only_fixed_codes() {
    let output = Capture::default();
    tracing::subscriber::with_default(subscriber(output.clone()), || {
        let metrics = Metrics::new();
        let guard = metrics.socket();
        metrics.report();
        for code in [
            Some(1011),
            Some(4008),
            Some(1001),
            Some(4001),
            Some(4003),
            Some(4029),
            Some(4999),
            None,
        ] {
            metrics.closed(code);
        }
        assert_eq!(
            metrics
                .closes
                .iter()
                .map(|value| value.load(Relaxed))
                .collect::<Vec<_>>(),
            vec![1; 8]
        );
        drop(guard);
        metrics.report();
    });
    let events = output.events();
    assert_eq!(events[0]["fields"]["event"], "websocket_opened");
    assert_eq!(events[1]["fields"]["active_websockets"], 1);
    assert_eq!(events.last().unwrap()["fields"]["active_websockets"], 0);
    assert!(!output.text().contains("4999"));
    let codes: Vec<_> = events
        .iter()
        .filter_map(|e| e["fields"]["code"].as_str())
        .collect();
    assert_eq!(
        codes,
        [
            "1011",
            "4008",
            "1001",
            "4001",
            "4003",
            "4029",
            "other",
            "peer_or_transport"
        ]
    );
}
