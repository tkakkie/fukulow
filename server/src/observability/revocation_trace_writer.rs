use std::{
    io::{self, Write},
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering::Relaxed},
        mpsc::{Receiver, SyncSender, sync_channel},
    },
    thread::{self, JoinHandle},
};
use tracing_subscriber::fmt::MakeWriter;

use super::REVOCATION_MEASUREMENT_TARGET;

const QUEUE_LINES: usize = 8;
const QUEUE_BYTES: usize = 32 * 1024;
pub(super) const TIMING_EVENT: &str = "subscription_fallback_timing";

#[derive(Default)]
pub(super) struct Counters {
    pub(super) attempted: AtomicU64,
    pub(super) dropped: AtomicU64,
    pub(super) timing_attempted: AtomicU64,
    queued_bytes: AtomicUsize,
}

struct Line {
    bytes: Box<[u8]>,
    timing: bool,
}

pub(super) struct TraceWriter {
    queue: SyncSender<Line>,
    counters: Arc<Counters>,
}

impl TraceWriter {
    pub(super) fn start(
        sink: impl Write + Send + 'static,
    ) -> io::Result<(Self, Arc<Counters>, JoinHandle<io::Result<()>>)> {
        let (queue, receiver) = sync_channel(QUEUE_LINES);
        let counters = Arc::new(Counters::default());
        let drain_counters = counters.clone();
        let thread = thread::Builder::new()
            .name("revocation-trace".into())
            .spawn(move || drain(sink, receiver, &drain_counters))?;
        Ok((
            Self {
                queue,
                counters: counters.clone(),
            },
            counters,
            thread,
        ))
    }
}

impl<'a> MakeWriter<'a> for TraceWriter {
    type Writer = EventWriter<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        EventWriter {
            writer: self,
            timing: false,
        }
    }

    fn make_writer_for(&'a self, meta: &tracing::Metadata<'_>) -> Self::Writer {
        EventWriter {
            writer: self,
            timing: meta.name() == TIMING_EVENT,
        }
    }
}

pub(super) struct EventWriter<'a> {
    writer: &'a TraceWriter,
    timing: bool,
}

impl Write for EventWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // The JSON fmt layer passes one complete line per write_all.
        let counters = &self.writer.counters;
        let len = bytes.len();
        let reserved = counters
            .queued_bytes
            .try_update(Relaxed, Relaxed, |queued| {
                (len <= QUEUE_BYTES - queued).then(|| queued + len)
            })
            .is_ok();
        let mut queued = false;
        if reserved {
            queued = self
                .writer
                .queue
                .try_send(Line {
                    bytes: bytes.into(),
                    timing: self.timing,
                })
                .is_ok();
            if !queued {
                counters.queued_bytes.fetch_sub(len, Relaxed);
            }
        }
        if !queued && !self.timing {
            counters.dropped.fetch_add(1, Relaxed);
        }
        Ok(len)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn drain(mut sink: impl Write, receiver: Receiver<Line>, counters: &Counters) -> io::Result<()> {
    let mut written = 0;
    let mut timing_written = 0;
    for line in receiver {
        counters.queued_bytes.fetch_sub(line.bytes.len(), Relaxed);
        sink.write_all(&line.bytes)?;
        if line.timing {
            timing_written += 1;
        } else {
            written += 1;
        }
    }
    let attempted = counters.attempted.load(Relaxed);
    let timing_attempted = counters.timing_attempted.load(Relaxed);
    let watermark = serde_json::json!({
        "level": "TRACE",
        "target": REVOCATION_MEASUREMENT_TARGET,
        "fields": {
            "event": "revocation_trace_watermark",
            "attempted": attempted,
            "written": written,
            "dropped": attempted - written,
            "timing_attempted": timing_attempted,
            "timing_written": timing_written,
            "timing_dropped": timing_attempted - timing_written,
        }
    });
    writeln!(sink, "{watermark}")?;
    sink.flush()
}
