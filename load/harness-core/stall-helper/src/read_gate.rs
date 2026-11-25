use std::io;
use std::sync::{Condvar, Mutex, PoisonError};

fn poisoned<T>(_: PoisonError<T>) -> io::Error {
    io::Error::other("stall read gate was poisoned")
}

#[derive(Default)]
struct State {
    paused: bool,
    reading: usize,
}

#[derive(Default)]
pub struct ReadGate {
    state: Mutex<State>,
    changed: Condvar,
}

impl ReadGate {
    pub fn read<T>(&self, read: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
        let mut state = self.state.lock().map_err(poisoned)?;
        while state.paused {
            state = self.changed.wait(state).map_err(poisoned)?;
        }
        state.reading += 1;
        drop(state);
        let result = read();
        let mut state = self.state.lock().map_err(poisoned)?;
        state.reading -= 1;
        if state.paused && state.reading == 0 {
            self.changed.notify_all();
        }
        result
    }

    pub fn pause(&self) -> io::Result<()> {
        let mut state = self.state.lock().map_err(poisoned)?;
        state.paused = true;
        // Acknowledging the pause must mean every in-flight read has returned.
        while state.reading != 0 {
            state = self.changed.wait(state).map_err(poisoned)?;
        }
        Ok(())
    }

    pub fn resume(&self, now: impl FnOnce() -> f64) -> io::Result<f64> {
        let mut state = self.state.lock().map_err(poisoned)?;
        state.paused = false;
        let at = now();
        self.changed.notify_all();
        Ok(at)
    }
}
