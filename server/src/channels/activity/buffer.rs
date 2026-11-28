use super::{Capture, Check, Entry, Notice, Revocations, Role, Uuid, holds::Holds};
use crate::{get_mut_ignoring_poison, lock_ignoring_poison};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::time::Instant;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Proof {
    pub(super) role: Role,
    pub(super) grant: Option<Uuid>,
}
#[derive(Default)]
pub(super) struct Recovery {
    state: Mutex<RecoveryState>,
}
#[derive(Default)]
struct RecoveryState {
    live: usize,
    settled: bool,
}
impl Recovery {
    pub(super) fn valid(&self) -> bool {
        let state = lock_ignoring_poison(&self.state);
        state.settled || state.live != 0
    }
    #[cfg(test)]
    pub(super) fn snapshot(&self) -> (usize, bool) {
        let state = lock_ignoring_poison(&self.state);
        (state.live, state.settled)
    }
}
pub(super) struct QueryToken {
    valid: AtomicBool,
    recovery: Mutex<Option<Arc<Recovery>>>,
}
impl QueryToken {
    pub(super) fn new() -> Self {
        Self {
            valid: AtomicBool::new(true),
            recovery: Mutex::new(None),
        }
    }
    pub(super) fn valid(&self) -> bool {
        self.valid.load(Ordering::Relaxed)
    }
    fn contribute(&self, recovery: &Arc<Recovery>) {
        // Each recipient query enqueues one contribution. Coalescing attaches its
        // token once; subsequent merges keep the same recovery accumulator.
        let mut contribution = lock_ignoring_poison(&self.recovery);
        if contribution.is_none() && self.valid() {
            lock_ignoring_poison(&recovery.state).live += 1;
            *contribution = Some(recovery.clone());
        }
    }
    pub(super) fn retire(&self) {
        let contribution = lock_ignoring_poison(&self.recovery);
        if self.valid.swap(false, Ordering::Relaxed)
            && let Some(recovery) = contribution.as_ref()
        {
            lock_ignoring_poison(&recovery.state).live -= 1;
        }
    }
}
impl Drop for QueryToken {
    fn drop(&mut self) {
        if self.valid()
            && let Some(recovery) = get_mut_ignoring_poison(&mut self.recovery).as_ref()
        {
            // No query guard, fallback snapshot or frame can fence this token
            // after its last owner drops. Retain its reset authority as one bit,
            // rather than retaining a growing list of completed query tokens.
            let mut state = lock_ignoring_poison(&recovery.state);
            state.settled = true;
            state.live -= 1;
        }
    }
}
#[derive(Clone)]
pub(super) enum Epoch {
    Notice(u64),
    Revocation(Arc<Capture>),
}
impl Epoch {
    pub(super) fn retained(&self, b: &Buffer) -> bool {
        match self {
            Self::Notice(epoch) => b.epoch == *epoch,
            Self::Revocation(capture) => capture.check().is_some(),
        }
    }
}
#[cfg_attr(test, derive(Clone))]
pub(super) struct Pending {
    pub(super) notice: Notice,
    // Payload-free DM invalidations still retain the causing access lifetime.
    pub(super) channel: Option<Uuid>,
    pub(super) epoch: Epoch,
    pub(super) directory_epoch: Option<u64>,
    pub(super) proof: Option<Proof>,
    pub(super) valid: Arc<QueryToken>,
    pub(super) recovery: Option<Arc<Recovery>>,
}
impl Pending {
    pub(super) fn recoverable(&self) -> bool {
        self.valid.valid() || self.recovery.as_ref().is_some_and(|r| r.valid())
    }
}
pub(super) struct InFlight {
    pub(super) channel: Option<Uuid>,
    pub(super) proof: Option<Proof>,
    pub(super) valid: Arc<QueryToken>,
}
#[derive(Default)]
pub(super) struct Buffer {
    pub(super) epoch: u64,
    pub(super) revocations: Revocations,
    pub(super) holds: Holds,
    pub(super) directory_epoch: u64,
    pub(super) pending: VecDeque<Pending>,
    pub(super) reset: bool,
    pub(super) proofs: HashMap<Option<Uuid>, Proof>,
    pub(super) in_flight: HashMap<Uuid, InFlight>,
}
impl Buffer {
    pub(super) fn retire_notices(&mut self) {
        self.holds.prune(&self.revocations, Instant::now());
        self.epoch = self.epoch.wrapping_add(1);
        let mut pending = std::mem::take(&mut self.pending);
        pending.retain(|p| p.epoch.retained(self));
        self.pending = pending;
        self.in_flight.clear();
        self.proofs.clear();
        self.reset &= !self.pending.is_empty();
    }

    pub(super) fn apply_revocation(
        &mut self,
        check: Check,
        identity: Option<&Proof>,
        access: Option<bool>,
    ) {
        // A fallback or publication can still fence a hold. Only its scheduled
        // handoff recheck can supply authority to deliver it.
        let access =
            access.filter(|&accessible| accessible || self.holds.deadline(check.id).is_none());
        self.apply_revocation_proof(check, identity, access);
    }

    pub(super) fn apply_revocation_proof(
        &mut self,
        check: Check,
        identity: Option<&Proof>,
        access: Option<bool>,
    ) {
        if self
            .revocations
            .apply(check, identity.map(|proof| proof.role), access)
        {
            self.retire_notices();
        }
    }
}
pub(super) fn enqueue(entry: &Entry, mut pending: Pending) {
    let mut b = lock_ignoring_poison(&entry.buffer);
    if !pending.valid.valid()
        || !pending.epoch.retained(&b)
        || pending
            .directory_epoch
            .is_some_and(|epoch| b.directory_epoch != epoch)
    {
        return;
    }
    b.pending.retain(Pending::recoverable);
    if b.pending.is_empty() {
        b.reset = false;
    }
    let channel = pending.channel;
    if let Some(proof) = &pending.proof {
        let conflict = b.proofs.get(&channel).is_some_and(|old| old != proof);
        let identity_changed = channel.is_none() && b.revocations.observe_identity(proof.role);
        if conflict
            || identity_changed
            || (b.proofs.len() == 256 && !b.proofs.contains_key(&channel))
        {
            b.retire_notices();
            return;
        }
        b.proofs.insert(channel, proof.clone());
    }
    if matches!(
        pending.notice,
        Notice::ChannelAccessGained { .. } | Notice::ChannelAccessRevoked { .. }
    ) && let Some(index) = b
        .pending
        .iter()
        .position(|p| p.notice.key() == pending.notice.key())
    {
        b.pending.remove(index);
        b.pending.push_back(pending);
        entry.wake.notify_one();
        return;
    }
    if let Some(old) = b.pending.iter_mut().find(|p| {
        p.notice.key() == pending.notice.key()
            && (!matches!(pending.notice, Notice::ChannelListChanged) || p.channel == channel)
    }) {
        let recovery = old.recovery.get_or_insert_with(Default::default).clone();
        old.valid.contribute(&recovery);
        pending.valid.contribute(&recovery);
        pending.recovery = Some(recovery);
        match (&mut old.notice, &pending.notice) {
            (Notice::ChannelActivity { seq, .. }, Notice::ChannelActivity { seq: new, .. })
                if *seq >= *new => {}
            (
                Notice::ReadPositionChanged { read_seq, .. },
                Notice::ReadPositionChanged { read_seq: new, .. },
            ) if *read_seq >= *new => {}
            (
                Notice::SectionsChanged { generation },
                Notice::SectionsChanged { generation: new },
            ) if *generation >= *new => {}
            _ => *old = pending,
        }
    } else if b.pending.len() == 256 {
        // Retain one proven contribution. Its lifetime is rechecked before reset handoff.
        b.pending.clear();
        b.reset = true;
        b.pending.push_back(pending);
    } else if !b.reset {
        b.pending.push_back(pending);
    }
    entry.wake.notify_one();
}
