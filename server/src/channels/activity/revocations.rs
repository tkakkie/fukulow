use super::*;
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct Revocations(Option<Arc<Mutex<Tracking>>>);

#[derive(Default)]
struct Tracking {
    sequence: u64,
    // Role changes require a new proof, while Membership loss is permanent.
    role: u64,
    member: u64,
    channels: BTreeMap<Uuid, u64>,
    live: BTreeMap<u64, (u64, Scope)>,
}

#[derive(Clone, Copy)]
enum Scope {
    Mutation(ChangeScope),
    Notice(NoticeProof),
}
impl Scope {
    fn channel(self) -> Option<Uuid> {
        match self {
            Self::Mutation(ChangeScope::Channel(channel)) => Some(channel),
            Self::Notice(proof) => Some(proof.channel),
            Self::Mutation(_) => None,
        }
    }
}

#[derive(Clone, Copy)]
struct NoticeProof {
    channel: Uuid,
    public: bool,
    role: Role,
    verified: Option<u64>,
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
    sequence: u64,
    generation: u64,
    pub(super) channel: Uuid,
    expected_role: Option<Role>,
    pub(super) needs_recheck: bool,
}

impl Tracking {
    fn retained(&self, sequence: u64, channel: Uuid, public: bool) -> bool {
        sequence >= self.member
            && (!public || sequence >= self.role)
            && self
                .channels
                .get(&channel)
                .is_none_or(|min| sequence >= *min)
    }

    fn check(&self, id: u64) -> Option<Check> {
        let &(sequence, Scope::Notice(proof)) = self.live.get(&id)? else {
            return None;
        };
        let generation = self.role.max(sequence);
        self.retained(sequence, proof.channel, proof.public)
            .then_some(Check {
                id,
                sequence,
                generation,
                channel: proof.channel,
                expected_role: (proof.verified.unwrap_or(sequence) == generation)
                    .then_some(proof.role),
                needs_recheck: proof.verified != Some(generation),
            })
    }

    fn retire_channel(&mut self, channel: Uuid, min: u64) {
        if Self::needs_change(&self.live, self.member, self.role, channel, min) {
            let previous = self.channels.entry(channel).or_default();
            *previous = (*previous).max(min);
        }
    }

    fn retire_member(&mut self, min: u64) {
        self.member = self.member.max(min);
        self.prune();
    }

    fn prune(&mut self) {
        self.channels.retain(|channel, min| {
            Self::needs_change(&self.live, self.member, self.role, *channel, *min)
        });
    }

    fn needs_change(
        live: &BTreeMap<u64, (u64, Scope)>,
        member: u64,
        role: u64,
        channel: Uuid,
        min: u64,
    ) -> bool {
        live.values().any(|(sequence, scope)| {
            let public = match scope {
                // Only public Channel access can be removed by a Role change.
                Scope::Mutation(ChangeScope::Role) => true,
                Scope::Notice(proof) => proof.public,
                Scope::Mutation(ChangeScope::Channel(_)) => false,
                Scope::Mutation(ChangeScope::Membership) => return false,
            };
            *sequence >= member
                && (!public || *sequence >= role)
                && *sequence < min
                && scope.channel().is_none_or(|id| id == channel)
        })
    }
}

impl Revocations {
    pub(super) fn capture(&mut self, scope: ChangeScope) -> Capture {
        let tracking = self.0.get_or_insert_with(Default::default);
        let mut state = tracking.lock().unwrap_or_else(|e| e.into_inner());
        Capture::new(tracking, &mut state, Scope::Mutation(scope), None)
    }

    pub(super) fn retire_member(&self) {
        if let Some(tracking) = &self.0 {
            let mut state = tracking.lock().unwrap_or_else(|e| e.into_inner());
            let min = state.sequence + 1;
            state.retire_member(min);
        }
    }

    pub(super) fn observe_identity(&self, role: Role) -> bool {
        self.checks()
            .into_iter()
            .filter(|check| check.expected_role.is_some_and(|expected| expected != role))
            .max_by_key(|check| check.generation)
            .is_some_and(|check| self.apply(check, Some(role), None))
    }

    pub(super) fn checks(&self) -> Vec<Check> {
        let Some(tracking) = &self.0 else {
            return Vec::new();
        };
        let state = tracking.lock().unwrap_or_else(|e| e.into_inner());
        state
            .live
            .keys()
            .filter_map(|&id| state.check(id))
            .collect()
    }

    // Returns whether ordinary notices must also retire.
    pub(super) fn apply(&self, check: Check, role: Option<Role>, access: Option<bool>) -> bool {
        let Some(tracking) = &self.0 else {
            return false;
        };
        let mut state = tracking.lock().unwrap_or_else(|e| e.into_inner());
        let Some(current) = state.check(check.id) else {
            return false;
        };
        if check.generation != current.generation {
            return false;
        }
        // A DB observation fences the work it checked, including that capture.
        // A newer capture can represent a mutation still in progress at the read.
        if role.is_none_or(|role| check.expected_role.is_some_and(|expected| expected != role)) {
            state.retire_member(check.generation + 1);
        } else if access == Some(true) {
            // Keep any newer, already captured removal of this Channel eligible.
            state.retire_channel(check.channel, check.sequence + 1);
        } else {
            if let Some((_, Scope::Notice(proof))) = state.live.get_mut(&check.id)
                && let (Some(role), Some(false)) = (role, access)
            {
                proof.role = role;
                proof.verified = Some(check.generation);
            }
            return false;
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
        match self.scope {
            Scope::Mutation(ChangeScope::Channel(channel)) => {
                state.retire_channel(channel, self.sequence)
            }
            Scope::Mutation(ChangeScope::Membership) => state.retire_member(self.sequence),
            Scope::Mutation(ChangeScope::Role) => {
                // Every Role change has implicit public access on at least one side.
                // Older public losses cannot survive that access lifetime.
                state.role = state.role.max(self.sequence);
                state.prune();
            }
            Scope::Notice(_) => {}
        }
    }

    pub(super) fn notice(&self, channel: Uuid, public: bool, role: Role) -> Option<Arc<Self>> {
        let tracking = self.tracking.upgrade()?;
        let mut state = tracking.lock().unwrap_or_else(|e| e.into_inner());
        let in_scope = match self.scope {
            Scope::Mutation(ChangeScope::Channel(id)) => id == channel,
            Scope::Mutation(ChangeScope::Role) => public,
            _ => false,
        };
        (in_scope && state.retained(self.sequence, channel, public)).then(|| {
            Arc::new(Self::new(
                &tracking,
                &mut state,
                Scope::Notice(NoticeProof {
                    channel,
                    public,
                    role,
                    verified: None,
                }),
                Some(self.sequence),
            ))
        })
    }

    pub(super) fn check(&self) -> Option<Check> {
        let tracking = self.tracking.upgrade()?;
        let state = tracking.lock().unwrap_or_else(|e| e.into_inner());
        state.check(self.id)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        if let Some(tracking) = self.tracking.upgrade() {
            let mut state = tracking.lock().unwrap_or_else(|e| e.into_inner());
            state.live.remove(&self.id);
            if let Some(channel) = self.scope.channel() {
                if state.channels.get(&channel).is_some_and(|min| {
                    !Tracking::needs_change(&state.live, state.member, state.role, channel, *min)
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
        let whole = revocations.capture(ChangeScope::Role);
        let channel = Uuid::new_v4();
        let notice = whole.notice(channel, true, Role::Guest).unwrap();
        for _ in 0..32 {
            revocations
                .capture(ChangeScope::Channel(Uuid::new_v4()))
                .retire();
        }
        assert_eq!(revocations.counts(), (2, 32));
        assert!(notice.check().is_some());
        revocations.capture(ChangeScope::Channel(channel)).retire();
        assert!(notice.check().is_none());
        drop(whole);
        assert_eq!(revocations.counts(), (1, 1));
        assert!(notice.check().is_none());
        drop(notice);
        assert_eq!(revocations.counts(), (0, 0));
    }
}
