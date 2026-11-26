use super::super::subscriber;
use serde_json::Value;
use std::{
    io::{self, Write},
    sync::{
        Arc, Mutex, Once,
        atomic::{AtomicBool, Ordering::Relaxed},
    },
};
use tracing::{
    Event, Metadata, Subscriber,
    callsite::rebuild_interest_cache,
    level_filters::LevelFilter,
    span::{Attributes, Id, Record},
    subscriber::{Interest, NoSubscriber, set_global_default},
};

#[derive(Clone)]
pub(crate) struct Capture(Arc<Mutex<Vec<u8>>>);

impl Default for Capture {
    fn default() -> Self {
        static INSTALL: Once = Once::new();
        INSTALL.call_once(|| {
            set_global_default(CaptureFallback).unwrap();
            ROUTER_INSTALLED.store(true, Relaxed);
            rebuild_interest_cache();
        });
        Self(Arc::default())
    }
}

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
    pub(crate) fn subscriber(&self) -> impl Subscriber + Send + Sync + use<> {
        subscriber(self.clone(), false)
    }

    pub(crate) fn measurement_subscriber(&self) -> impl Subscriber + Send + Sync + use<> {
        subscriber(self.clone(), true)
    }

    // Only for a fresh subprocess testing process-wide measurement.
    pub(crate) fn install_global_measurement() -> Self {
        let output = Self(Arc::default());
        set_global_default(output.measurement_subscriber()).unwrap();
        output
    }

    pub(crate) fn text(&self) -> String {
        String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
    }

    pub(crate) fn events(&self) -> Vec<Value> {
        self.text()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
}

static ROUTER_INSTALLED: AtomicBool = AtomicBool::new(false);

// Scoped dispatchers handle captures. The global fallback keeps their callsites
// eligible for dynamic filtering even when first reached on an unscoped thread.
struct CaptureFallback;

impl Subscriber for CaptureFallback {
    fn register_callsite(&self, _: &'static Metadata<'static>) -> Interest {
        Interest::sometimes()
    }

    fn max_level_hint(&self) -> Option<LevelFilter> {
        // Keep tracing macros off until the first dispatcher is the global default.
        // Dispatcher creation registers it before set_global_default publishes it.
        Some(if ROUTER_INSTALLED.load(Relaxed) {
            LevelFilter::TRACE
        } else {
            LevelFilter::OFF
        })
    }

    fn enabled(&self, _: &Metadata<'_>) -> bool {
        false
    }

    fn new_span(&self, attrs: &Attributes<'_>) -> Id {
        NoSubscriber::new().new_span(attrs)
    }

    fn event(&self, _: &Event<'_>) {}
    fn record(&self, _: &Id, _: &Record<'_>) {}
    fn record_follows_from(&self, _: &Id, _: &Id) {}
    fn enter(&self, _: &Id) {}
    fn exit(&self, _: &Id) {}
}

#[test]
fn capture_rebuilds_interest_for_a_callsite_registered_before_installation() {
    const CHILD: &str = "FUKULOW_TEST_CAPTURE_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let test = concat!(
            module_path!(),
            "::capture_rebuilds_interest_for_a_callsite_registered_before_installation"
        );
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test.split_once("::").unwrap().1, "--nocapture"])
            .env(CHILD, "1")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success() && stdout.contains("1 passed"),
            "{stdout}{stderr}"
        );
        return;
    }

    use tracing::callsite::DefaultCallsite;

    static CALLSITE: DefaultCallsite = DefaultCallsite::new(&META);
    static META: Metadata<'static> = tracing::metadata! {
        name: "capture_before_installation",
        target: "fukulow",
        level: tracing::Level::INFO,
        fields: &[],
        callsite: &CALLSITE,
        kind: tracing::metadata::Kind::EVENT,
    };

    assert!(
        std::thread::spawn(|| CALLSITE.register().is_never())
            .join()
            .unwrap()
    );
    let output = Capture::default();
    assert!(CALLSITE.interest().is_sometimes());

    tracing::subscriber::with_default(output.subscriber(), || {
        assert!(CALLSITE.interest().is_sometimes());
        assert!(tracing::dispatcher::get_default(
            |dispatch| dispatch.enabled(&META)
        ));
        Event::dispatch(&META, &META.fields().value_set(&[]));
    });
    assert_eq!(output.events().len(), 1);
}
