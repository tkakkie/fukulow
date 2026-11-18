use super::*;
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct Revocations(Option<Arc<Mutex<Tracking>>>);

#[derive(Default)]
struct Tracking {
    sequence: u64,
    // Minimum valid capture sequences, with Channel entries only for live older work.
    member: u64,
    channels: BTreeMap<Uuid, u64>,
    live: BTreeMap<u64, (u64, Scope)>,
}

#[derive(Clone, Copy)]
enum Scope {
    Mutation(Option<Uuid>),
    Notice(Uuid, Role),
}
impl Scope {
    fn channel(self) -> Option<Uuid> {
        match self {
            Self::Mutation(channel) => channel,
            Self::Notice(channel, _) => Some(channel),
        }
    }
}

pub(super) struct Capture {
    id: u64,
    sequence: u64,
    scope: Scope,
    // The last owner can drop while the socket buffer is locked.
    tracking: Weak<Mutex<Tracking>>,
}

#[derive(Clone, Copy)]
pub(super) struct Check {
    id: u64,
    pub(super) sequence: u64,
    pub(super) channel: Uuid,
    pub(super) role: Role,
}

impl Tracking {
    fn current(&self, sequence: u64, channel: Uuid) -> bool {
        sequence >= self.member
            && self
                .channels
                .get(&channel)
                .is_none_or(|min| sequence >= *min)
    }

    fn retire_channel(&mut self, channel: Uuid, min: u64) {
        if Self::needs_change(&self.live, self.member, channel, min) {
            let previous = self.channels.entry(channel).or_default();
            *previous = (*previous).max(min);
        }
    }

    fn retire_member(&mut self, min: u64) {
        self.member = self.member.max(min);
        self.prune();
    }

    fn prune(&mut self) {
        self.channels
            .retain(|channel, min| Self::needs_change(&self.live, self.member, *channel, *min));
    }

    fn needs_change(
        live: &BTreeMap<u64, (u64, Scope)>,
        member: u64,
        channel: Uuid,
        min: u64,
    ) -> bool {
        live.values().any(|(sequence, scope)| {
            *sequence >= member && *sequence < min && scope.channel().is_none_or(|id| id == channel)
        })
    }
}

impl Revocations {
    pub(super) fn capture(&mut self, channel: Option<Uuid>) -> Capture {
        let tracking = self.0.get_or_insert_with(Default::default);
        let mut state = tracking.lock().unwrap_or_else(|e| e.into_inner());
        Capture::new(tracking, &mut state, Scope::Mutation(channel), None)
    }

    pub(super) fn retire_member(&self) {
        if let Some(tracking) = &self.0 {
            let mut state = tracking.lock().unwrap_or_else(|e| e.into_inner());
            let min = state.sequence + 1;
            state.retire_member(min);
        }
    }

    pub(super) fn observe_identity(&self, role: Role) -> bool {
        let changed = self
            .checks()
            .into_iter()
            .filter(|check| check.role != role)
            .max_by_key(|check| check.sequence);
        changed.is_some_and(|check| self.observe(check, true))
    }

    pub(super) fn checks(&self) -> Vec<Check> {
        let Some(tracking) = &self.0 else {
            return Vec::new();
        };
        let state = tracking.lock().unwrap_or_else(|e| e.into_inner());
        state
            .live
            .iter()
            .filter_map(|(&id, &(sequence, scope))| {
                if let Scope::Notice(channel, role) = scope
                    && state.current(sequence, channel)
                {
                    Some(Check {
                        id,
                        sequence,
                        channel,
                        role,
                    })
                } else {
                    None
                }
            })
            .collect()
    }

    pub(super) fn observe(&self, check: Check, identity_changed: bool) -> bool {
        let Some(tracking) = &self.0 else {
            return false;
        };
        let mut state = tracking.lock().unwrap_or_else(|e| e.into_inner());
        if !state.live.contains_key(&check.id) || !state.current(check.sequence, check.channel) {
            return false;
        }
        // A DB observation fences the work it checked, including that capture.
        // A newer capture can represent a mutation still in progress at the read.
        if identity_changed {
            state.retire_member(check.sequence + 1);
        } else {
            state.retire_channel(check.channel, check.sequence + 1);
        }
        true
    }

    #[cfg(test)]
    pub(super) fn counts(&self) -> (usize, usize) {
        self.0.as_ref().map_or((0, 0), |tracking| {
            let state = tracking.lock().unwrap();
            (state.live.len(), state.channels.len())
        })
    }
}

impl Capture {
    fn new(
        tracking: &Arc<Mutex<Tracking>>,
        state: &mut Tracking,
        scope: Scope,
        sequence: Option<u64>,
    ) -> Self {
        state.sequence += 1;
        let capture = Self {
            id: state.sequence,
            sequence: sequence.unwrap_or(state.sequence),
            scope,
            tracking: Arc::downgrade(tracking),
        };
        state.live.insert(capture.id, (capture.sequence, scope));
        capture
    }

    pub(super) fn retire(&self) {
        let Some(tracking) = self.tracking.upgrade() else {
            return;
        };
        let mut state = tracking.lock().unwrap_or_else(|e| e.into_inner());
        // Capture calls are serialized by the mutation transaction's Organization
        // lock. Post-COMMIT callbacks can run in a different order.
        if let Some(channel) = self.scope.channel() {
            state.retire_channel(channel, self.sequence);
        } else {
            state.retire_member(self.sequence);
        }
    }

    pub(super) fn notice(&self, channel: Uuid, role: Role) -> Option<Arc<Self>> {
        let tracking = self.tracking.upgrade()?;
        let mut state = tracking.lock().unwrap_or_else(|e| e.into_inner());
        (self.scope.channel().is_none_or(|id| id == channel)
            && state.current(self.sequence, channel))
        .then(|| {
            Arc::new(Self::new(
                &tracking,
                &mut state,
                Scope::Notice(channel, role),
                Some(self.sequence),
            ))
        })
    }

    pub(super) fn current(&self) -> bool {
        self.tracking.upgrade().is_some_and(|tracking| {
            let state = tracking.lock().unwrap_or_else(|e| e.into_inner());
            self.scope
                .channel()
                .is_some_and(|channel| state.current(self.sequence, channel))
        })
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        if let Some(tracking) = self.tracking.upgrade() {
            let mut state = tracking.lock().unwrap_or_else(|e| e.into_inner());
            state.live.remove(&self.id);
            if let Some(channel) = self.scope.channel() {
                if state.channels.get(&channel).is_some_and(|min| {
                    !Tracking::needs_change(&state.live, state.member, channel, *min)
                }) {
                    state.channels.remove(&channel);
                }
            } else {
                state.prune();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sparse_revocation_history_follows_live_capture_scopes() {
        let mut revocations = Revocations::default();
        let whole = revocations.capture(None);
        let channel = Uuid::new_v4();
        let notice = whole.notice(channel, Role::Member).unwrap();
        for _ in 0..32 {
            revocations.capture(Some(Uuid::new_v4())).retire();
        }
        assert_eq!(revocations.counts(), (2, 32));
        assert!(notice.current());
        revocations.capture(Some(channel)).retire();
        assert!(!notice.current());
        drop(whole);
        assert_eq!(revocations.counts(), (1, 1));
        assert!(!notice.current());
        drop(notice);
        assert_eq!(revocations.counts(), (0, 0));
    }
}
