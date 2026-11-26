//! Coordinates one-shot pauses in real-time connection tests.

use crate::test_support::{Gate, Gates};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(in crate::realtime) enum Phase {
    Refresh,
    Live,
    Snapshot,
    Page,
    Frame,
    Authorize,
    AccessSubscribe,
    Registered,
    SubscribedSeq,
    HandoffGeneration,
}

static PHASE_GATES: Gates<(Uuid, Phase, i64)> = Gates::new();

// After registration and the history snapshot, before replay/handoff.
static REPLAY_GATES: Gates<Uuid> = Gates::new();

pub(super) fn register(channel: Uuid, phase: Phase, seq: i64) -> Arc<Gate> {
    PHASE_GATES.register((channel, phase, seq))
}

pub(in crate::realtime) async fn pause(channel: Uuid, phase: Phase, seq: i64) {
    PHASE_GATES.pause((channel, phase, seq)).await;
}

pub(super) fn register_replay(channel: Uuid) -> Arc<Gate> {
    REPLAY_GATES.register(channel)
}

pub(in crate::realtime) async fn pause_replay(channel: Uuid) {
    REPLAY_GATES.pause(channel).await;
}

pub(super) fn discard_replay(channel: &Uuid) {
    REPLAY_GATES.take(channel);
}
