//! Deterministic Message sync policy. The owner supplies all I/O results and timer ticks.
mod engine;
mod merge;
mod responses;
mod transitions;
mod types;
pub use types::*;

use std::collections::BTreeMap;
use uuid::Uuid;

/// Owns protocol state. There is deliberately no whole-State serialization API.
pub struct Core {
    pub(crate) session: SessionView,
    pub(crate) channels: BTreeMap<Uuid, ChannelView>,
    pub(crate) channel_order: Vec<Uuid>,
    pub(crate) requests: BTreeMap<Token, Request>,
    pub(crate) timers: BTreeMap<Token, Timer>,
}
impl Core {
    pub fn new(self_id: Uuid) -> Self {
        Self {
            session: SessionView {
                self_id,
                organization: Organization::Available,
                session: Session::SignedIn,
                running: false,
                next: 1,
                connection: None,
                connected: false,
                reconnect_attempt: 0,
                reconnect_wait: None,
            },
            channels: BTreeMap::new(),
            channel_order: Vec::new(),
            requests: BTreeMap::new(),
            timers: BTreeMap::new(),
        }
    }
    pub fn session(&self) -> &SessionView {
        &self.session
    }
    pub fn channel(&self, id: Uuid) -> Option<&ChannelView> {
        self.channels.get(&id)
    }
    pub fn request(&self, id: Token) -> Option<&Request> {
        self.requests.get(&id)
    }
    pub fn timer(&self, id: Token) -> Option<&Timer> {
        self.timers.get(&id)
    }
    pub fn has_pending(&self) -> bool {
        self.channels.iter().any(|(_, c)| !c.pending.is_empty())
    }
    pub fn step(&mut self, input: StepInput) -> StepResult {
        engine::Step::new(self).run(input)
    }
}
