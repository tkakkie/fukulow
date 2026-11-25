use std::{
    cell::Cell,
    io,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering::Relaxed},
    },
    thread::JoinHandle,
};

use super::{
    REVOCATION_MEASUREMENT_TARGET as TARGET, measurement_ms,
    revocation_trace_writer::{Counters, TIMING_EVENT, TraceWriter},
};

mod sink;

pub use sink::{Drain, start};

struct Recorder {
    dispatch: tracing::Dispatch,
    counters: Arc<Counters>,
    events: bool,
    check_seq: AtomicU64,
}

impl Recorder {
    fn start(
        sink: impl io::Write + Send + 'static,
        events: bool,
    ) -> io::Result<(Arc<Self>, JoinHandle<io::Result<()>>)> {
        let (writer, counters, thread) = TraceWriter::start(sink)?;
        let dispatch = tracing::Dispatch::new(super::subscriber(writer, true));
        Ok((
            Arc::new(Self {
                dispatch,
                counters,
                events,
                check_seq: AtomicU64::new(0),
            }),
            thread,
        ))
    }

    fn event(&self, emit: impl FnOnce(u64, u64)) {
        let seq = self.counters.attempted.fetch_add(1, Relaxed) + 1;
        let dropped = self.counters.dropped.load(Relaxed);
        tracing::dispatcher::with_default(&self.dispatch, || emit(seq, dropped));
    }
}

pub(crate) struct Worker {
    recorder: Arc<Recorder>,
    tick: u64,
}

impl Worker {
    pub(crate) fn current() -> Option<Self> {
        sink::current().map(|recorder| Self { recorder, tick: 0 })
    }

    pub(crate) fn tick(&mut self) -> Tick {
        self.tick += 1;
        Tick {
            recorder: self.recorder.clone(),
            tick: self.tick,
            started_ms: measurement_ms(),
            session_ms: 0.0,
            final_admission_ms: None,
            subscription_result: None,
        }
    }
}

pub(crate) struct Tick {
    recorder: Arc<Recorder>,
    tick: u64,
    started_ms: f64,
    session_ms: f64,
    final_admission_ms: Option<f64>,
    subscription_result: Option<(f64, &'static str)>,
}

struct CheckContext {
    recorder: Arc<Recorder>,
    final_admission_ms: Cell<Option<f64>>,
}

tokio::task_local! {
    static CHECK: CheckContext;
}

impl Tick {
    pub(crate) fn sessions_checked(&mut self) {
        self.session_ms = measurement_ms();
    }

    pub(crate) async fn check<T>(&mut self, work: impl Future<Output = T>) -> T {
        // Task-local state follows the worker across awaits and survives an inner timeout.
        let (result, final_admission_ms) = CHECK
            .scope(
                CheckContext {
                    recorder: self.recorder.clone(),
                    final_admission_ms: Cell::new(None),
                },
                async {
                    let result = work.await;
                    (
                        result,
                        CHECK
                            .try_with(|context| context.final_admission_ms.get())
                            .ok()
                            .flatten(),
                    )
                },
            )
            .await;
        self.final_admission_ms = final_admission_ms;
        result
    }

    pub(crate) fn subscription_checked(&mut self, outcome: impl FnOnce() -> &'static str) {
        if self.recorder.events {
            self.subscription_result = Some((measurement_ms(), outcome()));
        }
    }

    pub(crate) fn finish(self) {
        let tick = self.tick;
        let started_ms = self.started_ms;
        let session_ms = self.session_ms;
        let final_admission_ms = self.final_admission_ms;
        if self.recorder.events {
            let (completed_ms, outcome) = self
                .subscription_result
                .unwrap_or_else(|| (measurement_ms(), "none"));
            self.recorder.event(|trace_seq, trace_dropped| {
                tracing::trace!(target: TARGET, parent: None, event = "subscription_fallback_pass",
                    tick, started_ms, session_ms, completed_ms, outcome, trace_seq, trace_dropped);
            });
        }
        let completed_ms = measurement_ms();
        self.recorder
            .counters
            .timing_attempted
            .fetch_add(1, Relaxed);
        tracing::dispatcher::with_default(&self.recorder.dispatch, || {
            tracing::trace!(name: TIMING_EVENT, target: TARGET, parent: None, event = TIMING_EVENT,
                tick, started_ms, session_ms, final_admission_ms, completed_ms);
        });
    }
}

pub(crate) fn timing_enabled() -> bool {
    CHECK.try_with(|_| ()).is_ok()
}

pub(crate) fn admission_finished() {
    let _ = CHECK.try_with(|context| context.final_admission_ms.set(Some(measurement_ms())));
}

pub(crate) struct Pass {
    recorder: Arc<Recorder>,
    check_seq: u64,
    started_ms: f64,
    registrations: usize,
    rows: usize,
    chunks: usize,
    failed_chunks: usize,
}

impl Pass {
    pub(crate) fn start() -> Option<Self> {
        CHECK
            .try_with(|context| {
                context.recorder.events.then(|| Self {
                    recorder: context.recorder.clone(),
                    check_seq: context.recorder.check_seq.fetch_add(1, Relaxed) + 1,
                    started_ms: measurement_ms(),
                    registrations: 0,
                    rows: 0,
                    chunks: 0,
                    failed_chunks: 0,
                })
            })
            .ok()
            .flatten()
    }

    pub(crate) fn snapshot(
        &mut self,
        scanned: usize,
        registrations: usize,
        records: impl std::fmt::Display,
    ) {
        self.registrations = scanned;
        if registrations != 0 {
            let check_seq = self.check_seq;
            let server_ms = measurement_ms();
            self.recorder.event(|trace_seq, _| {
                tracing::trace!(target: TARGET, parent: None,
                event = "revocation_fallback_snapshot", check_seq, server_ms,
                registrations, trace_seq, records = %records)
            });
        }
    }

    pub(crate) fn chunk(&mut self, rows: usize) {
        self.rows += rows;
        self.chunks += 1;
    }

    pub(crate) fn failed_chunk(&mut self) {
        self.failed_chunks += 1;
    }

    pub(crate) fn finish(self, has_records: bool, records: impl std::fmt::Display) {
        let Self {
            recorder,
            check_seq,
            started_ms,
            registrations,
            rows,
            chunks,
            failed_chunks,
        } = self;
        let finished_ms = measurement_ms();
        if has_records {
            recorder.event(|trace_seq, _| {
                tracing::trace!(target: TARGET, parent: None,
                event = "revocation_fallback_outcome", check_seq, server_ms = finished_ms,
                trace_seq, records = %records)
            });
        }
        recorder.event(|trace_seq, _| {
            tracing::trace!(target: TARGET, parent: None,
            event = "revocation_fallback_check", check_seq, trace_seq, started_ms, finished_ms,
            registrations, rows, chunks, failed_chunks)
        });
    }
}

#[cfg(test)]
pub(crate) fn test_worker(
    sink: impl io::Write + Send + 'static,
    events: bool,
) -> (Worker, impl FnOnce() -> io::Result<()>) {
    let (recorder, thread) = Recorder::start(sink, events).unwrap();
    (Worker { recorder, tick: 0 }, || sink::join(thread))
}

#[cfg(test)]
mod tests;
