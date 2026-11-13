//! Socket admission (#196 A): per-Account and global connection caps, and the
//! control-frame budget charged per connection and per Account before any DB access.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Instant,
};
use uuid::Uuid;

const MILLIS_PER_TOKEN: u64 = 1000;
const NANOS_PER_MILLI: u128 = 1_000_000;
/// Account entries kept for budgets that outlive their connections. At the bound,
/// idle full entries are reclaimed, then the idle entry closest to full is evicted
/// (that Account's next connection starts with a full budget).
pub(crate) const MAX_ACCOUNTS: usize = 100_000;

/// A token bucket: `burst` frames at once, refilled at `per_second`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Budget {
    pub burst: u64,
    pub per_second: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SocketLimits {
    /// Open sockets per Account, across all its Organizations and Account Sessions.
    pub per_account: usize,
    pub global: usize,
    pub connection_frames: Budget,
    /// Shared by the Account's connections and kept across reconnects.
    pub account_frames: Budget,
    /// Initial read buffer per socket, in bytes.
    pub read_buffer: usize,
}

impl Default for SocketLimits {
    fn default() -> Self {
        Self {
            per_account: 32,
            global: 12_000,
            connection_frames: Budget {
                burst: 300,
                per_second: 4,
            },
            account_frames: Budget {
                burst: 600,
                per_second: 8,
            },
            read_buffer: 8 * 1024,
        }
    }
}

#[derive(Clone, Copy)]
struct Bucket {
    level: u64,
    /// Time already credited; never moves backwards, and the uncredited remainder of
    /// elapsed time is kept so frequent checks still refill.
    at: Instant,
}

impl Bucket {
    fn full(budget: Budget, now: Instant) -> Self {
        Self {
            level: budget.burst * MILLIS_PER_TOKEN,
            at: now,
        }
    }

    fn refill(&mut self, budget: Budget, now: Instant) {
        let capacity = budget.burst * MILLIS_PER_TOKEN;
        if self.level >= capacity || budget.per_second == 0 {
            self.level = self.level.min(capacity);
            self.at = self.at.max(now);
            return;
        }
        // per_second tokens/s is per_second milli-tokens per millisecond.
        let elapsed = now.saturating_duration_since(self.at).as_nanos();
        let rate = u128::from(budget.per_second);
        let added = elapsed * rate / NANOS_PER_MILLI;
        if added == 0 {
            return;
        }
        let space = u128::from(capacity - self.level);
        if added >= space {
            self.level = capacity;
            self.at = now;
            return;
        }
        // Credit only the time those milli-tokens took, rounded up so no time is
        // credited twice; the rest carries over.
        let used = (added * NANOS_PER_MILLI).div_ceil(rate);
        self.level += u64::try_from(added).unwrap_or(0);
        self.at += std::time::Duration::from_nanos(u64::try_from(used).unwrap_or(u64::MAX));
    }

    fn has_token(&mut self, budget: Budget, now: Instant) -> bool {
        self.refill(budget, now);
        self.level >= MILLIS_PER_TOKEN
    }

    fn is_full(&mut self, budget: Budget, now: Instant) -> bool {
        self.refill(budget, now);
        self.level == budget.burst * MILLIS_PER_TOKEN
    }
}

struct Account {
    connections: usize,
    frames: Bucket,
}

#[derive(Default)]
struct Inner {
    open: usize,
    accounts: HashMap<Uuid, Account>,
}

#[derive(Clone, Default)]
pub struct SocketGate {
    inner: Arc<Mutex<Inner>>,
    limits: SocketLimits,
}

impl SocketGate {
    pub fn new(limits: SocketLimits) -> Self {
        Self {
            limits,
            ..Self::default()
        }
    }

    pub(crate) fn limits(&self) -> SocketLimits {
        self.limits
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // Every step under the lock is await-free and leaves counts consistent.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Takes one per-Account slot and one global slot, or neither. The Account cap and
    /// budget are checked first, so a refused Account never holds a global slot.
    pub(crate) fn admit(&self, account: Uuid) -> Option<Permit> {
        self.admit_within(account, MAX_ACCOUNTS)
    }

    fn admit_within(&self, account: Uuid, max_accounts: usize) -> Option<Permit> {
        let limits = self.limits;
        let mut inner = self.lock();
        // Read under the lock, so shared buckets see time in lock order.
        let now = Instant::now();
        let (connections, exhausted) = match inner.accounts.get_mut(&account) {
            Some(a) => (
                a.connections,
                !a.frames.has_token(limits.account_frames, now),
            ),
            None => (0, false),
        };
        // An exhausted budget would close the socket at its first frame: refuse before
        // the upgrade, so a reconnect loop costs no connection setup or session check.
        if connections >= limits.per_account || exhausted || inner.open >= limits.global {
            return None;
        }
        if !inner.accounts.contains_key(&account) && inner.accounts.len() >= max_accounts {
            let budget = limits.account_frames;
            inner
                .accounts
                .retain(|_, a| a.connections > 0 || !a.frames.is_full(budget, now));
            // Still full: evict the idle entry closest to a full budget, so many
            // depleted Accounts cannot block new ones. Entries with open sockets are
            // at most the global cap, so one is always idle when the bound exceeds it.
            if inner.accounts.len() >= max_accounts {
                let (_, idle) = inner
                    .accounts
                    .iter_mut()
                    .filter(|(_, a)| a.connections == 0)
                    .map(|(id, a)| {
                        a.frames.refill(budget, now);
                        (a.frames.level, *id)
                    })
                    .max()?;
                inner.accounts.remove(&idle);
            }
        }
        inner.open += 1;
        inner
            .accounts
            .entry(account)
            .or_insert_with(|| Account {
                connections: 0,
                frames: Bucket::full(limits.account_frames, now),
            })
            .connections += 1;
        Some(Permit {
            gate: self.clone(),
            account,
            frames: Bucket::full(limits.connection_frames, now),
        })
    }

    #[cfg(test)]
    pub(crate) fn open(&self) -> (usize, usize) {
        let inner = self.lock();
        (inner.open, inner.accounts.len())
    }
}

/// One admitted socket's slots and frame budget; dropping it releases the slots.
pub(crate) struct Permit {
    gate: SocketGate,
    account: Uuid,
    frames: Bucket,
}

impl Permit {
    /// Charges one control frame to this connection and its Account. `false`: over
    /// budget, nothing charged.
    pub(crate) fn charge(&mut self) -> bool {
        let limits = self.gate.limits;
        if !self
            .frames
            .has_token(limits.connection_frames, Instant::now())
        {
            return false;
        }
        let mut inner = self.gate.lock();
        let now = Instant::now();
        let Some(account) = inner.accounts.get_mut(&self.account) else {
            return false;
        };
        if !account.frames.has_token(limits.account_frames, now) {
            return false;
        }
        account.frames.level -= MILLIS_PER_TOKEN;
        self.frames.level -= MILLIS_PER_TOKEN;
        true
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        let budget = self.gate.limits.account_frames;
        let mut inner = self.gate.lock();
        let now = Instant::now();
        inner.open = inner.open.saturating_sub(1);
        let idle = match inner.accounts.get_mut(&self.account) {
            Some(account) => {
                account.connections = account.connections.saturating_sub(1);
                account.connections == 0 && account.frames.is_full(budget, now)
            }
            None => false,
        };
        if idle {
            inner.accounts.remove(&self.account);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate(per_account: usize, global: usize, connection: u64, account: u64) -> SocketGate {
        SocketGate::new(SocketLimits {
            per_account,
            global,
            connection_frames: Budget {
                burst: connection,
                per_second: 1,
            },
            account_frames: Budget {
                burst: account,
                per_second: 1,
            },
            read_buffer: 4096,
        })
    }

    #[test]
    fn account_cap_is_checked_before_the_global_cap_and_permits_release_both() {
        let gate = gate(2, 3, 10, 10);
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let a1 = gate.admit(a).unwrap();
        let _a2 = gate.admit(a).unwrap();
        // Over its own cap, A takes no global slot: B still gets the last one.
        assert!(gate.admit(a).is_none());
        assert_eq!(gate.open().0, 2);
        let b1 = gate.admit(b).unwrap();
        assert!(gate.admit(b).is_none(), "global cap");
        drop(a1);
        let _b2 = gate.admit(b).unwrap();
        drop(b1);
        assert_eq!(gate.open().0, 2);
    }

    #[test]
    fn the_account_budget_is_shared_and_outlives_its_connections() {
        let gate = gate(4, 10, 3, 4);
        let account = Uuid::new_v4();
        let mut first = gate.admit(account).unwrap();
        assert!((0..3).all(|_| first.charge()));
        assert!(!first.charge(), "connection budget");
        let mut second = gate.admit(account).unwrap();
        assert!(second.charge());
        assert!(!second.charge(), "account budget shared");
        drop((first, second));
        // Reconnecting does not reset the Account's budget: the upgrade is refused.
        assert_eq!(gate.open(), (0, 1));
        assert!(gate.admit(account).is_none());
        assert_eq!(gate.open(), (0, 1));
    }

    #[test]
    fn a_refused_frame_charges_nothing_and_full_idle_accounts_are_released() {
        let gate = gate(4, 10, 1, 5);
        let account = Uuid::new_v4();
        let mut permit = gate.admit(account).unwrap();
        assert!(permit.charge());
        assert!(!permit.charge());
        // The connection refusal left the Account's tokens: another socket uses them.
        let mut other = gate.admit(account).unwrap();
        assert!(other.charge());
        drop((permit, other));
        assert_eq!(gate.open(), (0, 1));
        let fresh = gate.admit(Uuid::new_v4()).unwrap();
        drop(fresh);
        // An Account whose budget is full leaves no entry.
        assert_eq!(gate.open(), (0, 1));
    }

    fn empty(budget: Budget, at: Instant) -> Bucket {
        let mut bucket = Bucket::full(budget, at);
        bucket.level = 0;
        bucket
    }

    #[test]
    fn frequent_checks_keep_the_elapsed_remainder() {
        let budget = Budget {
            burst: 600,
            per_second: 8,
        };
        let start = Instant::now();
        let mut bucket = empty(budget, start);
        // Every 50 µs for one second: each check alone adds 0.4 milli-tokens.
        for step in 1..=20_000u64 {
            bucket.refill(budget, start + std::time::Duration::from_micros(50 * step));
        }
        assert_eq!(bucket.level, 8 * MILLIS_PER_TOKEN);
    }

    #[test]
    fn an_earlier_timestamp_never_credits_time_twice() {
        let budget = Budget {
            burst: 600,
            per_second: 8,
        };
        let start = Instant::now();
        let second = std::time::Duration::from_secs(1);
        let mut bucket = empty(budget, start);
        bucket.refill(budget, start + 2 * second);
        // A caller that sampled its time earlier arrives late.
        bucket.refill(budget, start + second);
        bucket.refill(budget, start + 2 * second);
        assert_eq!(bucket.level, 16 * MILLIS_PER_TOKEN);
        // Refill saturates at the burst.
        bucket.refill(budget, start + 1000 * second);
        assert_eq!(bucket.level, 600 * MILLIS_PER_TOKEN);
    }

    #[test]
    fn the_account_table_bound_evicts_only_idle_entries_and_never_blocks_new_accounts() {
        let gate = gate(4, 10, 10, 10);
        let (a, b, c, d) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        let _a = gate.admit_within(a, 2).unwrap();
        let mut b1 = gate.admit_within(b, 2).unwrap();
        assert!((0..5).all(|_| b1.charge()));
        drop(b1);
        // B is idle but depleted (5 s to refill): kept until the table is full.
        assert_eq!(gate.open(), (1, 2));
        // Accounts already in the table are admitted at the bound without eviction.
        let a2 = gate.admit_within(a, 2).unwrap();
        // A new Account at the bound evicts the idle entry, never an active one.
        let _c = gate.admit_within(c, 2).unwrap();
        assert_eq!(gate.open(), (3, 2));
        let mut b2 = gate.admit_within(b, 3).unwrap();
        assert!(b2.charge(), "an evicted Account starts with a full budget");
        // Every entry active: a new Account is refused.
        assert!(gate.admit_within(d, 3).is_none());
        drop(a2);
        assert_eq!(gate.open(), (3, 3));
    }
}
