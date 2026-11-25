use super::sink::join;
use super::*;
use crate::observability::tests::Capture;
use serde_json::Value;
use std::{
    io::Write,
    os::unix::fs::PermissionsExt,
    process::Command,
    sync::mpsc::{Receiver, Sender, channel},
    time::Duration,
};

struct StalledSink {
    output: Capture,
    started: Option<Sender<()>>,
    release: Receiver<()>,
}

impl Write for StalledSink {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if let Some(started) = self.started.take() {
            started.send(()).unwrap();
            self.release.recv_timeout(Duration::from_secs(10)).unwrap();
        }
        self.output.write(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.output.flush()
    }
}

fn stalled_sink() -> (StalledSink, Receiver<()>, Sender<()>) {
    let (started, entered) = channel();
    let (release, wait) = channel();
    (
        StalledSink {
            output: Capture::default(),
            started: Some(started),
            release: wait,
        },
        entered,
        release,
    )
}

fn pass(recorder: &Recorder) {
    recorder.event(|trace_seq, trace_dropped| {
        tracing::trace!(target: TARGET, parent: None, event = "subscription_fallback_pass", trace_seq, trace_dropped);
    });
}

#[test]
fn drained_watermark_detects_dropped_final_s1_with_a_clean_prefix() {
    let (sink, entered, release) = stalled_sink();
    let output = sink.output.clone();
    let (recorder, thread) = Recorder::start(sink, true).unwrap();
    pass(&recorder);
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    for _ in 0..9 {
        pass(&recorder);
    }
    assert!(output.text().is_empty());
    release.send(()).unwrap();
    drop(recorder);
    join(thread).unwrap();
    let lines = output.events();
    assert_eq!(lines.len(), 10);
    for (index, line) in lines[..9].iter().enumerate() {
        let fields = &line["fields"];
        assert_eq!(fields["event"], "subscription_fallback_pass");
        assert_eq!(fields["trace_seq"], index + 1);
        assert_eq!(fields["trace_dropped"], 0);
    }
    let watermark = &lines[9]["fields"];
    assert_eq!(watermark["event"], "revocation_trace_watermark");
    assert_eq!(watermark["attempted"], 10);
    assert_eq!(watermark["written"], 9);
    assert_eq!(watermark["dropped"], 1);
}

#[test]
fn queued_byte_limit_drops_lines_and_s1_reports_the_gap() {
    let (sink, entered, release) = stalled_sink();
    let output = sink.output.clone();
    let (recorder, thread) = Recorder::start(sink, true).unwrap();
    pass(&recorder);
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    for payload in [
        "a".repeat(16 * 1024),
        "b".repeat(16 * 1024),
        "c".repeat(32 * 1024),
    ] {
        recorder.event(|trace_seq, _| {
            tracing::trace!(target: TARGET, parent: None, event = "revocation_fallback_snapshot",
                trace_seq, records = payload);
        });
    }
    pass(&recorder);
    release.send(()).unwrap();
    drop(recorder);
    join(thread).unwrap();
    let events = output.events();
    assert_eq!(events.len(), 4);
    assert_eq!(events[0]["fields"]["trace_seq"], 1);
    assert_eq!(events[1]["fields"]["trace_seq"], 2);
    assert_eq!(events[2]["fields"]["trace_seq"], 5);
    assert_eq!(events[2]["fields"]["trace_dropped"], 2);
    assert_eq!(events[3]["fields"]["dropped"], 2);
}

#[tokio::test]
async fn pass_emits_after_leaving_the_task_local_scope() {
    let output = Capture::default();
    let (mut worker, drain) = test_worker(output.clone(), true);
    let mut pass = worker.tick().check(async { Pass::start().unwrap() }).await;
    assert!(!timing_enabled());
    drop(worker);

    pass.snapshot(1, 1, "snapshot");
    pass.finish(true, "outcome");
    drain().unwrap();

    let events = output.events();
    assert_eq!(events.len(), 4);
    for (index, name) in [
        "revocation_fallback_snapshot",
        "revocation_fallback_outcome",
        "revocation_fallback_check",
    ]
    .into_iter()
    .enumerate()
    {
        let fields = &events[index]["fields"];
        assert_eq!(fields["event"], name);
        assert_eq!(fields["check_seq"], 1);
        assert_eq!(fields["trace_seq"], index + 1);
    }
    assert_eq!(events[3]["fields"]["written"], 3);
}

#[test]
fn revocation_trace_switch_is_nested_and_existing_measurement_stays_on() {
    const CHILD: &str = "FUKULOW_TEST_REVOCATION_TRACE_MODE";
    const OUTER: &str = "FUKULOW_REVOCATION_MEASUREMENT";
    const INNER: &str = "FUKULOW_REVOCATION_TRACE_EVENTS";
    if std::env::var_os(CHILD).is_some() {
        super::super::init().unwrap();
        let drain = start().unwrap();
        let mut worker = Worker::current();
        let enabled = std::env::var(OUTER).as_deref() == Ok("1");
        assert_eq!(drain.is_some(), enabled);
        assert_eq!(worker.is_some(), enabled);
        tracing::trace!(target: TARGET, parent: None, event = "revocation_holds_sample");
        if let Some(mut worker) = worker.take() {
            let mut tick = worker.tick();
            tick.sessions_checked();
            tick.finish();
        }
        if let Some(drain) = drain {
            drain.finish().unwrap();
        }
        return;
    }

    let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir(&dir).unwrap();
    for (index, (mode, switch)) in [
        (None, Some("1")),
        (Some("0"), None),
        (Some("01"), Some("0")),
        (Some("1"), Some("0")),
        (Some("1"), None),
        (Some("1"), Some("00")),
    ]
    .into_iter()
    .enumerate()
    {
        let path = dir.join(index.to_string());
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "observability::revocation_trace::tests::revocation_trace_switch_is_nested_and_existing_measurement_stays_on", "--nocapture"])
            .env(CHILD, "1").env("FUKULOW_REVOCATION_TRACE_PATH", &path).env_remove(OUTER).env_remove(INNER);
        if let Some(value) = mode {
            command.env(OUTER, value);
        }
        if let Some(value) = switch {
            command.env(INNER, value);
        }
        let output = command.output().unwrap();
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(output.status.success(), "{stderr}");
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        if mode == Some("1") {
            assert!(stderr.contains("revocation_holds_sample"));
            assert!(!stderr.contains("subscription_fallback_"));
            let permissions = std::fs::metadata(&path).unwrap().permissions();
            assert_eq!(permissions.mode() & 0o777, 0o600);
            let trace = std::fs::read_to_string(&path).unwrap();
            assert!(!trace.contains("revocation_holds_sample"));
            assert!(trace.contains(TIMING_EVENT));
            assert_eq!(
                trace.contains("subscription_fallback_pass"),
                switch != Some("0")
            );
            let watermark: Value = serde_json::from_str(trace.lines().last().unwrap()).unwrap();
            assert_eq!(
                watermark["fields"]["attempted"],
                u64::from(switch != Some("0"))
            );
            assert_eq!(watermark["fields"]["timing_written"], 1);
        } else {
            assert!(stderr.is_empty(), "{stderr}");
            assert!(!path.exists());
        }
    }
    std::fs::remove_dir_all(dir).unwrap();
}
