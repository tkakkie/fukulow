use crate::lock_ignoring_poison;
use std::{
    collections::HashMap,
    sync::Mutex,
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
    #[cfg(test)]
    test_now: Option<Instant>,
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
                #[cfg(test)]
                test_now: None,
            }),
            burst: REFILL_INTERVAL * burst,
        }
    }

    pub(super) fn acquire(&self, member: Member) -> Result<Permit<'_>, Duration> {
        let mut state = lock_ignoring_poison(&self.state);
        let now = Instant::now();
        #[cfg(test)]
        let now = state.test_now.unwrap_or(now);
        state.acquire(member, now, self.burst)?;
        Ok(Permit {
            limiter: self,
            member,
        })
    }

    #[cfg(test)]
    pub(super) fn freeze_test_clock(&self) {
        lock_ignoring_poison(&self.state).test_now = Some(Instant::now());
    }
}

impl State {
    fn acquire(&mut self, member: Member, now: Instant, burst: Duration) -> Result<(), Duration> {
        if now >= self.next_sweep {
            self.members
                .retain(|_, entry| entry.active || entry.full_at > now);
            self.next_sweep = now + SWEEP_INTERVAL;
        }
        if self.members.len() >= MAX_MEMBERS && !self.members.contains_key(&member) {
            return Err(SWEEP_INTERVAL);
        }
        let entry = self.members.entry(member).or_insert(Entry {
            active: false,
            full_at: now,
        });
        // Time until a full bucket represents its outstanding token debt.
        let full_at = entry.full_at.max(now) + REFILL_INTERVAL;
        if entry.active {
            return Err(REFILL_INTERVAL);
        }
        let burst_end = now + burst;
        if full_at > burst_end {
            return Err(full_at - burst_end);
        }
        entry.active = true;
        entry.full_at = full_at;
        Ok(())
    }
}

pub(super) struct Permit<'a> {
    limiter: &'a Limiter,
    member: Member,
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut state = lock_ignoring_poison(&self.limiter.state);
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
            assert_eq!(state.acquire(member, now, limiter.burst), Ok(()));
            state.members.get_mut(&member).unwrap().active = false;
        }
        assert_eq!(
            state.acquire(member, now, limiter.burst),
            Err(REFILL_INTERVAL)
        );
        let half_refill = REFILL_INTERVAL / 2;
        assert_eq!(
            state.acquire(member, now + half_refill, limiter.burst),
            Err(half_refill)
        );
        let refill = now + REFILL_INTERVAL;
        assert_eq!(state.acquire(member, refill, limiter.burst), Ok(()));
        state.members.get_mut(&member).unwrap().active = false;
        assert_eq!(
            state.acquire(member, refill, limiter.burst),
            Err(REFILL_INTERVAL)
        );
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
                    .is_ok()
            );
        }
        let extra = (org, Uuid::new_v4());
        assert_eq!(
            state.acquire(extra, now, limiter.burst),
            Err(SWEEP_INTERVAL)
        );
        let idle = (org, Uuid::nil());
        state.members.get_mut(&idle).unwrap().active = false;
        assert_eq!(
            state.acquire(extra, now, limiter.burst),
            Err(SWEEP_INTERVAL)
        );
        assert!(
            state
                .acquire(extra, now + SWEEP_INTERVAL, limiter.burst)
                .is_ok()
        );
        assert_eq!(state.members.len(), MAX_MEMBERS);
        assert!(!state.members.contains_key(&idle));
        assert!(state.members[&(org, Uuid::from_u128(1))].active);
    }
}
