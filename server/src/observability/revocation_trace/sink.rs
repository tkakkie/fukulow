use std::{
    fs::OpenOptions,
    io,
    os::unix::fs::OpenOptionsExt,
    sync::{Arc, Mutex},
    thread::JoinHandle,
};

use super::Recorder;
use crate::observability::revocation_measurement_enabled;

const SINK_ENV: &str = "FUKULOW_REVOCATION_TRACE_PATH";
static RECORDER: Mutex<Option<Arc<Recorder>>> = Mutex::new(None);

pub struct Drain(JoinHandle<io::Result<()>>);

pub fn start() -> io::Result<Option<Drain>> {
    if !revocation_measurement_enabled() {
        return Ok(None);
    }
    let path = std::env::var_os(SINK_ENV).ok_or_else(|| {
        io::Error::other("FUKULOW_REVOCATION_TRACE_PATH is required for measurement")
    })?;
    // A new file cannot alias stderr or be an existing FIFO or device.
    let sink = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|error| {
            io::Error::other(format!("could not create {SINK_ENV}: {}", error.kind()))
        })?;
    let events = std::env::var("FUKULOW_REVOCATION_TRACE_EVENTS").as_deref() != Ok("0");
    let (recorder, thread) = Recorder::start(sink, events)?;
    *crate::lock_ignoring_poison(&RECORDER) = Some(recorder);
    Ok(Some(Drain(thread)))
}

pub(super) fn current() -> Option<Arc<Recorder>> {
    if !revocation_measurement_enabled() {
        return None;
    }
    crate::lock_ignoring_poison(&RECORDER).clone()
}

impl Drain {
    /// Call after the runtime has stopped all trace producers.
    pub fn finish(self) -> io::Result<()> {
        crate::lock_ignoring_poison(&RECORDER).take();
        join(self.0)
    }
}

pub(super) fn join(thread: JoinHandle<io::Result<()>>) -> io::Result<()> {
    thread
        .join()
        .map_err(|_| io::Error::other("revocation trace writer stopped"))?
}
