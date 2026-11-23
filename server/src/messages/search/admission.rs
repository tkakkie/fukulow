use std::{
    collections::HashMap,
    sync::{Mutex, PoisonError},
    time::{Duration, Instant},
};
use uuid::Uuid;

pub(in crate::messages) const BURST: u32 = 5;
const REFILL_INTERVAL: Duration = Duration::from_millis(500);
const MAX_MEMBERS: usize = 10_000;
const SWEEP_INTERVAL: Duration = Duration::from_secs(1);
type Member = (Uuid, Uuid);

pub(in crate::messages) struct Limiter {
    state: Mutex<State>,
    burst: Duration,
}

struct State {
    members: HashMap<Member, Entry>,
    next_sweep: Instant,
}

struct Entry {
    active: bool,
    full_at: Instant,
}

impl Limiter {
    pub(super) fn new(burst: u32) -> Self {
        Self {
            state: Mutex::new(State {
                members: HashMap::new(),
                next_sweep: Instant::now(),
            }),
            burst: REFILL_INTERVAL * burst,
        }
    }

    pub(super) fn acquire(&self, member: Member) -> Option<Permit<'_>> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.acquire(member, Instant::now(), self.burst)?;
        Some(Permit {
            limiter: self,
            member,
        })
    }
}

impl State {
    fn acquire(&mut self, member: Member, now: Instant, burst: Duration) -> Option<()> {
        if now >= self.next_sweep {
            self.members
                .retain(|_, entry| entry.active || entry.full_at > now);
            self.next_sweep = now + SWEEP_INTERVAL;
        }
        if self.members.len() >= MAX_MEMBERS && !self.members.contains_key(&member) {
            return None;
        }
        let entry = self.members.entry(member).or_insert(Entry {
            active: false,
            full_at: now,
        });
        // Time until a full bucket represents its outstanding token debt.
        let full_at = entry.full_at.max(now) + REFILL_INTERVAL;
        if entry.active || full_at > now + burst {
            return None;
        }
        entry.active = true;
        entry.full_at = full_at;
        Some(())
    }
}

pub(super) struct Permit<'a> {
    limiter: &'a Limiter,
    member: Member,
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut state = self
            .limiter
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(entry) = state.members.get_mut(&self.member) {
            entry.active = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_refills_one_token_at_a_time() {
        let limiter = Limiter::new(BURST);
        let mut state = limiter.state.lock().unwrap();
        let now = state.next_sweep;
        let member = (Uuid::new_v4(), Uuid::new_v4());
        for _ in 0..BURST {
            assert!(state.acquire(member, now, limiter.burst).is_some());
            state.members.get_mut(&member).unwrap().active = false;
        }
        assert!(state.acquire(member, now, limiter.burst).is_none());
        let refill = now + REFILL_INTERVAL;
        assert!(state.acquire(member, refill, limiter.burst).is_some());
        state.members.get_mut(&member).unwrap().active = false;
        assert!(state.acquire(member, refill, limiter.burst).is_none());
    }

    #[test]
    fn tracking_cap_reclaims_only_idle_full_buckets() {
        let limiter = Limiter::new(BURST);
        let mut state = limiter.state.lock().unwrap();
        let now = state.next_sweep;
        let org = Uuid::new_v4();
        for i in 0..MAX_MEMBERS {
            assert!(
                state
                    .acquire((org, Uuid::from_u128(i as u128)), now, limiter.burst)
                    .is_some()
            );
        }
        let extra = (org, Uuid::new_v4());
        assert!(state.acquire(extra, now, limiter.burst).is_none());
        let idle = (org, Uuid::nil());
        state.members.get_mut(&idle).unwrap().active = false;
        assert!(state.acquire(extra, now, limiter.burst).is_none());
        assert!(
            state
                .acquire(extra, now + SWEEP_INTERVAL, limiter.burst)
                .is_some()
        );
        assert_eq!(state.members.len(), MAX_MEMBERS);
        assert!(!state.members.contains_key(&idle));
        assert!(state.members[&(org, Uuid::from_u128(1))].active);
    }
}
