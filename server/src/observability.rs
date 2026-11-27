//! Process-local, bounded observations. This leaf never depends on domain modules.
use axum::{
    extract::{MatchedPath, Request},
    middleware::Next,
    response::Response,
};
use std::{
    sync::{
        Arc, LazyLock,
        atomic::{AtomicU64, Ordering::Relaxed},
    },
    time::{Duration, Instant},
};
use tracing::Instrument;
use tracing_subscriber::{
    filter::{LevelFilter, Targets},
    layer::SubscriberExt,
    util::SubscriberInitExt,
};

pub(crate) mod notice_permits;
pub mod revocation_trace;
mod revocation_trace_writer;

pub const INTERVAL: Duration = Duration::from_secs(60);
const REVOCATION_SAMPLE_INTERVAL: Duration = Duration::from_millis(250);
const TARGET: &str = "fukulow";
pub(crate) const REVOCATION_MEASUREMENT_TARGET: &str = "fukulow_revocation_measurement";
static MEASURE_REVOCATIONS: LazyLock<bool> =
    LazyLock::new(|| std::env::var("FUKULOW_REVOCATION_MEASUREMENT").as_deref() == Ok("1"));
static MEASUREMENT_EPOCH: LazyLock<Instant> = LazyLock::new(Instant::now);
static METRICS: LazyLock<Metrics> = LazyLock::new(Metrics::new);

// Only our reviewed fields are enabled: dependency diagnostics can include SQL,
// parameters, URIs or credentials. RUST_LOG cannot broaden this allowlist.
pub fn init() -> Result<(), Box<dyn std::error::Error>> {
    // First startup action, before subscriber setup or Tokio runtime construction.
    // Do not delegate to the default hook: dependency panic payloads can be secrets.
    std::panic::set_hook(Box::new(|_| {
        use std::io::Write;
        let _ = std::io::stderr().lock().write_all(
            b"{\"level\":\"ERROR\",\"target\":\"fukulow\",\"fields\":{\"event\":\"panic\"}}\n",
        );
    }));
    subscriber(std::io::stderr, revocation_measurement_enabled()).try_init()?;
    Ok(())
}

fn subscriber<W>(writer: W, measure_revocations: bool) -> impl tracing::Subscriber + Send + Sync
where
    W: for<'a> tracing_subscriber::fmt::MakeWriter<'a> + Send + Sync + 'static,
{
    let measurement_level = if measure_revocations {
        LevelFilter::TRACE
    } else {
        LevelFilter::OFF
    };
    let targets = Targets::new()
        .with_target(TARGET, tracing::Level::INFO)
        .with_target(REVOCATION_MEASUREMENT_TARGET, measurement_level);
    tracing_subscriber::registry().with(targets).with(
        tracing_subscriber::fmt::layer()
            .json()
            .with_writer(writer)
            .with_current_span(true)
            .with_span_list(false),
    )
}

pub(crate) fn revocation_measurement_enabled() -> bool {
    *MEASURE_REVOCATIONS
}

pub(crate) fn measurement_ms() -> f64 {
    MEASUREMENT_EPOCH.elapsed().as_secs_f64() * 1000.0
}

pub(crate) struct RevocationHoldCounts {
    pub active_holds: usize,
    pub high_water_mark: usize,
    pub retry_attempts: u64,
}

pub(crate) fn spawn_revocation_holds_sampler(
    sample: impl Fn() -> RevocationHoldCounts + Send + 'static,
) -> Option<tokio::task::JoinHandle<()>> {
    notice_permits::notice_permit_gauges().map(|gauges| {
        tokio::spawn(async move {
            let period = REVOCATION_SAMPLE_INTERVAL;
            let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                ticks.tick().await;
                let counts = sample();
                tracing::trace!(
                    target: REVOCATION_MEASUREMENT_TARGET,
                    parent: None,
                    event = "revocation_holds_sample",
                    server_ms = measurement_ms(),
                    active_holds = counts.active_holds,
                    high_water_mark = counts.high_water_mark,
                    retry_attempts = counts.retry_attempts,
                );
                gauges.emit();
            }
        })
    })
}

pub(crate) async fn request(request: Request, next: Next) -> Response {
    // Never reflect inbound X-Request-Id: it is untrusted, potentially secret data.
    let span = tracing::info_span!(target: TARGET, "http_request", request_id = %uuid::Uuid::new_v4(),
        method = method(request.method()),
        route = request.extensions().get::<MatchedPath>().map_or("<unmatched>", MatchedPath::as_str),
        status = tracing::field::Empty, duration_ms = tracing::field::Empty);
    async move {
        let started = Instant::now();
        let response = next.run(request).await;
        let span = tracing::Span::current();
        span.record("status", response.status().as_u16());
        span.record("duration_ms", started.elapsed().as_secs_f64() * 1000.0);
        tracing::info!(target: TARGET, event = "http_completed");
        response
    }
    .instrument(span)
    .await
}

fn method(method: &axum::http::Method) -> &'static str {
    match method.as_str() {
        "GET" => "GET",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        "HEAD" => "HEAD",
        "OPTIONS" => "OPTIONS",
        _ => "OTHER",
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Admission {
    SendChannelQueue,
    SendGlobalQueue,
    SendChannel,
    SendGlobal,
    WatermarkChannel,
    WatermarkGlobal,
    NotificationChannel,
    NotificationGlobal,
    NotificationOrganization,
    NotificationExecution,
    Socket,
    Password,
}
impl Admission {
    const ALL: [Self; 12] = [
        Self::SendChannelQueue,
        Self::SendGlobalQueue,
        Self::SendChannel,
        Self::SendGlobal,
        Self::WatermarkChannel,
        Self::WatermarkGlobal,
        Self::NotificationChannel,
        Self::NotificationGlobal,
        Self::NotificationOrganization,
        Self::NotificationExecution,
        Self::Socket,
        Self::Password,
    ];
    fn name(self) -> &'static str {
        match self {
            Self::SendChannelQueue => "send_channel_queue",
            Self::SendGlobalQueue => "send_global_queue",
            Self::SendChannel => "send_channel",
            Self::SendGlobal => "send_global",
            Self::WatermarkChannel => "watermark_channel",
            Self::WatermarkGlobal => "watermark_global",
            Self::NotificationChannel => "notification_channel",
            Self::NotificationGlobal => "notification_global",
            Self::NotificationOrganization => "notification_organization",
            Self::NotificationExecution => "notification_execution",
            Self::Socket => "socket",
            Self::Password => "password",
        }
    }
}

struct Metrics {
    active: AtomicU64,
    // Fixed boxed slices avoid the module-direction driver's ICE on struct array lengths.
    closes: Box<[AtomicU64]>,
    admissions: Box<[AtomicU64]>,
    revocations: Arc<RevocationMetrics>,
}

#[derive(Clone, Copy)]
pub(crate) enum RevocationMetric {
    Held,
    Delivered,
    RegistrationCap,
    GlobalCap,
    Timeout,
    Retries,
    Fenced,
    RecheckError,
}

pub(crate) struct RevocationMetrics(Box<[AtomicU64]>);

impl Default for RevocationMetrics {
    fn default() -> Self {
        Self(Box::new([const { AtomicU64::new(0) }; 8]))
    }
}

impl RevocationMetrics {
    pub(crate) fn count(&self, kind: RevocationMetric) {
        self.0[kind as usize].fetch_add(1, Relaxed);
    }

    pub(crate) fn load(&self, kind: RevocationMetric) -> u64 {
        self.0[kind as usize].load(Relaxed)
    }
}

pub(crate) fn revocation_metrics() -> Arc<RevocationMetrics> {
    METRICS.revocations.clone()
}

impl Metrics {
    fn reject(&self, kind: Admission) {
        self.admissions[kind as usize].fetch_add(1, Relaxed);
    }
    fn new() -> Self {
        Self {
            active: AtomicU64::new(0),
            closes: Box::new([const { AtomicU64::new(0) }; 8]),
            admissions: Box::new([const { AtomicU64::new(0) }; Admission::ALL.len()]),
            revocations: Arc::default(),
        }
    }
    fn report(&self) {
        // JSON includes the current span even on root events; isolate aggregates.
        let span = tracing::info_span!(target: TARGET, parent: None, "aggregates");
        let _entered = span.enter();
        let revocations = |kind| self.revocations.load(kind);
        use RevocationMetric::*;
        tracing::info!(target: TARGET, parent: None, event = "metrics", interval_seconds = INTERVAL.as_secs(),
            active_websockets = self.active.load(Relaxed),
            close_1001 = self.closes[0].load(Relaxed), close_1011 = self.closes[1].load(Relaxed),
            close_4001 = self.closes[2].load(Relaxed), close_4003 = self.closes[3].load(Relaxed),
            close_4008 = self.closes[4].load(Relaxed), close_4029 = self.closes[5].load(Relaxed),
            close_other = self.closes[6].load(Relaxed), peer_or_transport_end = self.closes[7].load(Relaxed),
            admission_rejections = self.admissions.iter().map(|counter| counter.load(Relaxed)).sum::<u64>(),
            revocation_held = revocations(Held),
            revocation_delivered_after_hold = revocations(Delivered),
            revocation_retired_registration_cap = revocations(RegistrationCap),
            revocation_retired_global_cap = revocations(GlobalCap),
            revocation_retired_timeout = revocations(Timeout),
            revocation_retired_retries = revocations(Retries),
            revocation_retired_fenced = revocations(Fenced),
            revocation_recheck_errors = revocations(RecheckError));
        for kind in Admission::ALL {
            let count = self.admissions[kind as usize].load(Relaxed);
            if count > 0 {
                tracing::info!(target: TARGET, parent: None, event = "admission_rejected", kind = kind.name(), count);
            }
        }
    }
}

pub(crate) fn admission(kind: Admission) {
    METRICS.reject(kind);
}

#[cfg(test)]
pub(crate) fn socket_counts() -> (u64, u64) {
    (
        METRICS.admissions[Admission::Socket as usize].load(Relaxed),
        METRICS.closes[close_bucket(Some(4029)).0].load(Relaxed),
    )
}

pub async fn report_periodically() {
    report_metrics(&METRICS).await;
}

async fn report_metrics(metrics: &Metrics) {
    let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + INTERVAL, INTERVAL);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticks.tick().await;
        metrics.report();
    }
}

pub(crate) struct Socket<'a>(&'a Metrics);
impl Socket<'static> {
    pub(crate) fn opened() -> Self {
        METRICS.socket()
    }
}
impl Metrics {
    fn socket(&self) -> Socket<'_> {
        self.active.fetch_add(1, Relaxed);
        tracing::info!(target: TARGET, event = "websocket_opened");
        Socket(self)
    }
}
impl Drop for Socket<'_> {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Relaxed);
        tracing::info!(target: TARGET, event = "websocket_disconnected");
    }
}

fn close_bucket(code: Option<u16>) -> (usize, &'static str) {
    match code {
        Some(1001) => (0, "1001"),
        Some(1011) => (1, "1011"),
        Some(4001) => (2, "4001"),
        Some(4003) => (3, "4003"),
        Some(4008) => (4, "4008"),
        Some(4029) => (5, "4029"),
        Some(_) => (6, "other"),
        None => (7, "peer_or_transport"),
    }
}
pub(crate) fn socket_closed(code: Option<u16>) {
    METRICS.closed(code);
}

impl Metrics {
    fn closed(&self, code: Option<u16>) {
        let (bucket, code) = close_bucket(code);
        self.closes[bucket].fetch_add(1, Relaxed);
        tracing::info!(target: TARGET, event = "websocket_closed", code);
    }
}

// Error Display/Debug/source, DB details and SQLSTATE are deliberately never logged.
pub fn database_failure(error: &sqlx::Error) {
    let kind = match error {
        sqlx::Error::PoolTimedOut => "pool_timeout",
        sqlx::Error::PoolClosed => "pool_closed",
        sqlx::Error::Io(error) if error.kind() == std::io::ErrorKind::WouldBlock => "admission",
        sqlx::Error::Io(error) if error.kind() == std::io::ErrorKind::TimedOut => "deadline",
        sqlx::Error::Io(_) => "io",
        sqlx::Error::Database(_) => "database",
        _ => "other",
    };
    // Admission sites are counted and aggregated, never re-logged through ApiError.
    if kind != "admission" {
        tracing::warn!(target: TARGET, event = "database_failure", kind);
    }
}

#[cfg(test)]
pub(crate) mod tests;
