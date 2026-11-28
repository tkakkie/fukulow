use crate::lock_ignoring_poison;
use std::{
    collections::HashMap,
    hash::Hash,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use axum::{extract::ConnectInfo, http::HeaderMap};
use tokio::time::Instant;
use uuid::Uuid;

mod client_ip;

use client_ip::ClientIp;

const WINDOW: Duration = Duration::from_secs(60);
const IP_LIMIT: u32 = 20;
const ACCOUNT_LIMIT: u32 = 5;
pub(super) const SECURITY_SESSION_LIMIT: u32 = 3;
pub(super) const SECURITY_ACCOUNT_LIMIT: u32 = 5;
pub(super) const MAX_KEYS: usize = 10_000;

type Account = String;

#[derive(Clone, Default)]
pub struct SignInThrottle {
    buckets: Arc<Mutex<Buckets>>,
    client_ip: ClientIp,
}

#[derive(Default)]
struct Buckets {
    ips: HashMap<IpAddr, Bucket>,
    accounts: HashMap<Account, Bucket>,
    last_prune: Option<Instant>,
}

struct Bucket {
    failures: u32,
    pending: u32,
    expires: Instant,
}

impl Bucket {
    fn refresh(&mut self, now: Instant) {
        if now >= self.expires {
            self.failures = 0;
            self.expires = now + WINDOW;
        }
    }
}

fn reserve<K: Clone + Eq + Hash>(
    buckets: &mut HashMap<K, Bucket>,
    key: K,
    limit: u32,
    now: Instant,
) -> Result<(), Duration> {
    if !buckets.contains_key(&key) && buckets.len() >= MAX_KEYS {
        buckets.retain(|_, bucket| bucket.pending > 0 || bucket.expires > now);
        if buckets.len() >= MAX_KEYS {
            // Keep reservations addressable until Drop, even across window expiry.
            let oldest = buckets
                .iter()
                .filter(|(_, bucket)| bucket.pending == 0)
                .min_by_key(|(_, bucket)| bucket.expires)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                buckets.remove(&oldest);
            } else {
                return Err(WINDOW);
            }
        }
    }
    let bucket = buckets.entry(key).or_insert(Bucket {
        failures: 0,
        pending: 0,
        expires: now + WINDOW,
    });
    bucket.refresh(now);
    if bucket.failures + bucket.pending >= limit {
        return Err(bucket.expires.saturating_duration_since(now));
    }
    bucket.pending += 1;
    Ok(())
}

fn ip_key(ip: IpAddr) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V4(ip) => IpAddr::V4(ip),
        IpAddr::V6(ip) => {
            let [a, b, c, d, ..] = ip.segments();
            IpAddr::from([a, b, c, d, 0, 0, 0, 0])
        }
    }
}

impl SignInThrottle {
    #[cfg(test)]
    pub(super) fn pending_counts(&self) -> (u32, u32) {
        let buckets = self.lock();
        (
            buckets.ips.values().map(|bucket| bucket.pending).sum(),
            buckets.accounts.values().map(|bucket| bucket.pending).sum(),
        )
    }

    /// Proxy peer IPs/CIDRs, plus a header whose rightmost value is the client IP.
    /// Both settings must be present; the default trusts no forwarded headers.
    pub fn with_proxy_config(
        peers: Option<&str>,
        header: Option<&str>,
    ) -> Result<Self, &'static str> {
        let client_ip = ClientIp::from_config(peers, header)?;
        Ok(Self {
            client_ip,
            ..Self::default()
        })
    }

    pub(super) fn client_ip(&self, peer: ConnectInfo<SocketAddr>, headers: &HeaderMap) -> IpAddr {
        self.client_ip.select(peer, headers)
    }

    fn lock(&self) -> MutexGuard<'_, Buckets> {
        lock_ignoring_poison(&self.buckets)
    }

    pub(super) fn begin(&self, ip: IpAddr) -> Result<Attempt, Duration> {
        let now = Instant::now();
        let mut buckets = self.lock();
        if buckets
            .last_prune
            .is_none_or(|last| now.duration_since(last) >= WINDOW)
        {
            buckets
                .ips
                .retain(|_, bucket| bucket.pending > 0 || bucket.expires > now);
            buckets
                .accounts
                .retain(|_, bucket| bucket.pending > 0 || bucket.expires > now);
            buckets.last_prune = Some(now);
        }
        let ip = ip_key(ip);
        reserve(&mut buckets.ips, ip, IP_LIMIT, now)?;
        Ok(Attempt {
            throttle: self.clone(),
            ip,
            account: None,
            failed: false,
        })
    }
}

// Reserve before awaiting database/password work so concurrent requests cannot
// all pass the failure check. Cancellation, errors and success release the slot.
pub(super) struct Attempt {
    throttle: SignInThrottle,
    ip: IpAddr,
    account: Option<Account>,
    failed: bool,
}

impl Attempt {
    pub(super) fn account(&mut self, email: String) -> Result<(), Duration> {
        let account = email;
        reserve(
            &mut self.throttle.lock().accounts,
            account.clone(),
            ACCOUNT_LIMIT,
            Instant::now(),
        )?;
        self.account = Some(account);
        Ok(())
    }

    pub(super) fn failed(mut self) {
        self.failed = true;
    }
}

impl Drop for Attempt {
    fn drop(&mut self) {
        let mut buckets = self.throttle.lock();
        if let Some(key) = &self.account {
            release(&mut buckets.accounts, key, self.failed);
        }
        release(&mut buckets.ips, &self.ip, self.failed);
    }
}

fn release<K: Eq + Hash>(buckets: &mut HashMap<K, Bucket>, key: &K, failed: bool) {
    if let Some(bucket) = buckets.get_mut(key) {
        bucket.pending -= 1;
        if failed {
            bucket.refresh(Instant::now());
            bucket.failures += 1;
        }
        if bucket.failures == 0 && bucket.pending == 0 {
            buckets.remove(key);
        }
    }
}

#[derive(Clone, Default)]
pub struct AccountSecurityThrottle {
    buckets: Arc<Mutex<SecurityBuckets>>,
}

#[derive(Default)]
struct SecurityBuckets {
    sessions: HashMap<Vec<u8>, Bucket>,
    accounts: HashMap<Uuid, Bucket>,
    last_prune: Option<Instant>,
}

impl AccountSecurityThrottle {
    fn lock(&self) -> MutexGuard<'_, SecurityBuckets> {
        lock_ignoring_poison(&self.buckets)
    }

    pub(super) fn begin(
        &self,
        session: Vec<u8>,
        account: Uuid,
    ) -> Result<SecurityAttempt, Duration> {
        let mut buckets = self.lock();
        let now = Instant::now();
        if buckets
            .last_prune
            .is_none_or(|last| now.duration_since(last) >= WINDOW)
        {
            buckets
                .sessions
                .retain(|_, bucket| bucket.pending > 0 || bucket.expires > now);
            buckets
                .accounts
                .retain(|_, bucket| bucket.pending > 0 || bucket.expires > now);
            buckets.last_prune = Some(now);
        }
        reserve(
            &mut buckets.sessions,
            session.clone(),
            SECURITY_SESSION_LIMIT,
            now,
        )?;
        if let Err(retry) = reserve(&mut buckets.accounts, account, SECURITY_ACCOUNT_LIMIT, now) {
            release(&mut buckets.sessions, &session, false);
            return Err(retry);
        }
        Ok(SecurityAttempt {
            throttle: self.clone(),
            session,
            account,
            failed: false,
        })
    }

    #[cfg(test)]
    pub(super) fn counts(&self, session: &[u8], account: Uuid) -> ((u32, u32), (u32, u32)) {
        let buckets = self.lock();
        let counts = |bucket: Option<&Bucket>| {
            bucket.map_or((0, 0), |bucket| (bucket.failures, bucket.pending))
        };
        (
            counts(buckets.sessions.get(session)),
            counts(buckets.accounts.get(&account)),
        )
    }
}

pub(super) struct SecurityAttempt {
    throttle: AccountSecurityThrottle,
    session: Vec<u8>,
    account: Uuid,
    failed: bool,
}

impl SecurityAttempt {
    pub(super) fn failed(mut self) {
        self.failed = true;
    }
}

impl Drop for SecurityAttempt {
    fn drop(&mut self) {
        let mut buckets = self.throttle.lock();
        release(&mut buckets.sessions, &self.session, self.failed);
        release(&mut buckets.accounts, &self.account, self.failed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::PasswordWorkers;

    fn ip(n: u8) -> IpAddr {
        IpAddr::from([192, 0, 2, n])
    }

    fn security_keys(n: usize) -> (Vec<u8>, Uuid) {
        let id = Uuid::from_u128(n as u128);
        (id.as_bytes().repeat(2), id)
    }

    #[tokio::test(start_paused = true)]
    async fn authenticated_maps_stay_bounded_evict_oldest_idle_and_prune_expired() {
        let throttle = AccountSecurityThrottle::default();
        let (pending_session, pending_account) = security_keys(0);
        let pending = throttle
            .begin(pending_session.clone(), pending_account)
            .unwrap();
        tokio::time::advance(WINDOW).await;
        let (oldest_session, oldest_account) = security_keys(1);
        throttle
            .begin(oldest_session.clone(), oldest_account)
            .unwrap()
            .failed();
        tokio::time::advance(Duration::from_millis(1)).await;
        for n in 2..MAX_KEYS {
            let (session, account) = security_keys(n);
            throttle.begin(session, account).unwrap().failed();
        }
        let (session, account) = security_keys(MAX_KEYS);
        let new = throttle.begin(session.clone(), account).unwrap();
        {
            let buckets = throttle.lock();
            assert_eq!(buckets.sessions.len(), MAX_KEYS);
            assert_eq!(buckets.accounts.len(), MAX_KEYS);
            assert!(!buckets.sessions.contains_key(&oldest_session));
            assert!(!buckets.accounts.contains_key(&oldest_account));
        }
        assert_eq!(
            throttle.counts(&pending_session, pending_account),
            ((0, 1), (0, 1))
        );
        pending.failed();
        assert_eq!(
            throttle.counts(&pending_session, pending_account),
            ((1, 0), (1, 0))
        );
        drop(new);

        tokio::time::advance(WINDOW).await;
        let _new = throttle.begin(session, account).unwrap();
        let buckets = throttle.lock();
        assert_eq!(buckets.sessions.len(), 1);
        assert_eq!(buckets.accounts.len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn authenticated_maps_keep_pending_at_capacity_until_drop() {
        let throttle = AccountSecurityThrottle::default();
        let mut pending: Vec<_> = (0..MAX_KEYS)
            .map(|n| {
                let (session, account) = security_keys(n);
                throttle.begin(session, account).unwrap()
            })
            .collect();
        tokio::time::advance(WINDOW).await;
        let (session, account) = security_keys(MAX_KEYS);
        assert_eq!(throttle.begin(session.clone(), account).err(), Some(WINDOW));
        drop(pending.pop());
        let new = throttle.begin(session, account).unwrap();
        {
            let buckets = throttle.lock();
            assert_eq!(buckets.sessions.len(), MAX_KEYS);
            assert_eq!(buckets.accounts.len(), MAX_KEYS);
        }
        drop((pending, new));
        let buckets = throttle.lock();
        assert!(buckets.sessions.is_empty());
        assert!(buckets.accounts.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn failures_expire_and_success_does_not_clear_other_failures() {
        let throttle = SignInThrottle::default();
        for _ in 0..ACCOUNT_LIMIT - 1 {
            let mut attempt = throttle.begin(ip(1)).unwrap();
            attempt.account("owner@example.com".into()).unwrap();
            attempt.failed();
        }
        // A success releases only its own reservation.
        let mut success = throttle.begin(ip(1)).unwrap();
        success.account("owner@example.com".into()).unwrap();
        drop(success);
        let mut attempt = throttle.begin(ip(1)).unwrap();
        attempt.account("owner@example.com".into()).unwrap();
        attempt.failed();
        let mut rejected = throttle.begin(ip(2)).unwrap();
        assert_eq!(rejected.account("owner@example.com".into()), Err(WINDOW));
        drop(rejected);
        tokio::time::advance(WINDOW - Duration::from_millis(1)).await;
        let mut rejected = throttle.begin(ip(2)).unwrap();
        assert!(rejected.account("owner@example.com".into()).is_err());
        drop(rejected);
        tokio::time::advance(Duration::from_millis(1)).await;
        let mut allowed = throttle.begin(ip(1)).unwrap();
        allowed.account("owner@example.com".into()).unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn concurrent_reservations_are_bounded_and_cancellation_releases_them() {
        let throttle = SignInThrottle::default();
        let mut attempts = Vec::new();
        for n in 0..ACCOUNT_LIMIT {
            let mut attempt = throttle.begin(ip(n as u8)).unwrap();
            attempt.account("owner@example.com".into()).unwrap();
            attempts.push(attempt);
        }
        // Unfinished password work still counts across window boundaries.
        tokio::time::advance(WINDOW).await;
        let mut rejected = throttle.begin(ip(10)).unwrap();
        assert!(rejected.account("owner@example.com".into()).is_err());
        drop(attempts.pop());
        rejected.account("owner@example.com".into()).unwrap();
        drop(rejected);
        for attempt in attempts {
            attempt.failed();
        }
        let mut attempt = throttle.begin(ip(10)).unwrap();
        attempt.account("owner@example.com".into()).unwrap();
        attempt.failed();
        let mut rejected = throttle.begin(ip(10)).unwrap();
        assert!(rejected.account("owner@example.com".into()).is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn ip_budget_is_shared_across_accounts_but_not_ips() {
        let throttle = SignInThrottle::default();
        for n in 0..IP_LIMIT {
            let mut attempt = throttle.begin(ip(1)).unwrap();
            attempt.account(format!("{n}@example.com")).unwrap();
            attempt.failed();
        }
        assert!(throttle.begin(ip(1)).is_err());
        assert!(throttle.begin(ip(2)).is_ok());
        tokio::time::advance(WINDOW).await;
        assert!(throttle.begin(ip(1)).is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn mapped_ipv6_shares_the_ipv4_budget() {
        let throttle = SignInThrottle::default();
        let mapped = "::ffff:192.0.2.1".parse().unwrap();
        for n in 0..IP_LIMIT {
            throttle
                .begin(if n % 2 == 0 { ip(1) } else { mapped })
                .unwrap()
                .failed();
        }
        assert!(throttle.begin(ip(1)).is_err());
        assert!(throttle.begin(mapped).is_err());
        assert!(throttle.begin(ip(2)).is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn ipv6_prefix_pending_reservations_release_on_drop() {
        let throttle = SignInThrottle::default();
        let mut attempts = Vec::new();
        for n in 0..IP_LIMIT {
            attempts.push(
                throttle
                    .begin(format!("2001:db8:abcd:1::{n}").parse().unwrap())
                    .unwrap(),
            );
        }
        let fresh = "2001:db8:abcd:1::ffff".parse().unwrap();
        assert!(throttle.begin(fresh).is_err());
        drop(attempts.pop());
        drop(throttle.begin(fresh).unwrap());
        drop(attempts);
        assert!(throttle.lock().ips.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn full_ip_map_allows_successful_password_verification_and_stays_bounded() {
        static WORKERS: PasswordWorkers = PasswordWorkers::new();

        let password = "correct horse battery staple";
        let stored = crate::auth::hash_password(password.into(), &WORKERS)
            .await
            .unwrap();
        let throttle = SignInThrottle::default();
        // Successful/cancelled attempts leave no idle IP bucket.
        for n in 0..MAX_KEYS as u32 {
            drop(throttle.begin(IpAddr::from(n.to_be_bytes())).unwrap());
        }
        assert!(throttle.lock().ips.is_empty());
        // Failed attempts may fill the map, but cannot lock out a new source.
        for n in 0..MAX_KEYS as u32 {
            throttle
                .begin(IpAddr::from(n.to_be_bytes()))
                .unwrap()
                .failed();
        }
        assert_eq!(throttle.lock().ips.len(), MAX_KEYS);
        let mut attempt = throttle.begin(ip(1)).unwrap();
        attempt.account("owner@example.com".into()).unwrap();
        assert_eq!(throttle.lock().ips.len(), MAX_KEYS);
        assert!(
            crate::auth::check_password(
                password.into(),
                Some(stored),
                attempt,
                WORKERS.acquire().await.unwrap(),
            )
            .await
            .unwrap()
        );
        let buckets = throttle.lock();
        assert_eq!(buckets.ips.len(), MAX_KEYS - 1);
        assert!(!buckets.ips.contains_key(&ip(1)));
        assert!(buckets.ips.values().all(|bucket| bucket.pending == 0));
    }

    #[tokio::test(start_paused = true)]
    async fn ip_eviction_removes_oldest_idle_bucket_and_preserves_pending_reservations() {
        let throttle = SignInThrottle::default();
        let pending = throttle.begin(ip(1)).unwrap();
        // An expired pending reservation must survive both pruning and eviction.
        tokio::time::advance(WINDOW).await;
        throttle.begin(ip(2)).unwrap().failed();
        tokio::time::advance(Duration::from_millis(1)).await;
        for n in 0..MAX_KEYS as u32 - 2 {
            throttle
                .begin(IpAddr::from(n.to_be_bytes()))
                .unwrap()
                .failed();
        }
        let new = throttle.begin(ip(3)).unwrap();
        {
            let buckets = throttle.lock();
            assert_eq!(buckets.ips.len(), MAX_KEYS);
            assert!(!buckets.ips.contains_key(&ip(2)));
            assert_eq!(buckets.ips[&ip(1)].pending, 1);
        }
        pending.failed();
        drop(new);
        let buckets = throttle.lock();
        assert_eq!(buckets.ips[&ip(1)].pending, 0);
        assert_eq!(buckets.ips[&ip(1)].failures, 1);
        assert_eq!(buckets.ips.len(), MAX_KEYS - 1);
    }

    #[tokio::test(start_paused = true)]
    async fn full_ip_map_keeps_pending_reservations_bounded_until_drop() {
        let throttle = SignInThrottle::default();
        let mut attempts = Vec::new();
        for n in 0..MAX_KEYS as u32 {
            attempts.push(throttle.begin(IpAddr::from(n.to_be_bytes())).unwrap());
        }
        tokio::time::advance(WINDOW).await;
        assert!(throttle.begin(ip(1)).is_err());
        assert_eq!(throttle.lock().ips.len(), MAX_KEYS);
        drop(attempts.pop());
        let new = throttle.begin(ip(1)).unwrap();
        assert_eq!(throttle.lock().ips.len(), MAX_KEYS);
        drop(attempts);
        drop(new);
        assert!(throttle.lock().ips.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn bucket_storage_is_bounded_and_expired_entries_are_purged() {
        let throttle = SignInThrottle::default();
        for n in 0..MAX_KEYS {
            let mut attempt = throttle
                .begin(IpAddr::from((n as u32).to_be_bytes()))
                .unwrap();
            attempt.account(format!("{n}@example.com")).unwrap();
            attempt.failed();
        }
        let mut rejected = throttle.begin(ip(1)).unwrap();
        rejected.account("overflow@example.com".into()).unwrap();
        assert_eq!(throttle.lock().accounts.len(), MAX_KEYS);
        drop(rejected);
        tokio::time::advance(WINDOW).await;
        let mut allowed = throttle.begin(ip(1)).unwrap();
        allowed.account("overflow@example.com".into()).unwrap();
        assert_eq!(throttle.lock().accounts.len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn account_reclamation_preserves_pending_and_evicts_oldest_idle() {
        let throttle = SignInThrottle::default();
        let mut pending = throttle.begin(ip(1)).unwrap();
        pending.account("pending@example.com".into()).unwrap();
        tokio::time::advance(WINDOW).await;
        let mut oldest = throttle.begin(ip(2)).unwrap();
        oldest.account("oldest@example.com".into()).unwrap();
        oldest.failed();
        tokio::time::advance(Duration::from_millis(1)).await;
        for n in 0..MAX_KEYS as u32 - 2 {
            let mut attempt = throttle.begin(IpAddr::from(n.to_be_bytes())).unwrap();
            attempt.account(format!("unknown-{n}@example.com")).unwrap();
            attempt.failed();
        }
        let mut new = throttle.begin(ip(3)).unwrap();
        new.account("new@example.com".into()).unwrap();
        {
            let buckets = throttle.lock();
            assert_eq!(buckets.accounts.len(), MAX_KEYS);
            assert_eq!(buckets.accounts["pending@example.com"].pending, 1);
            assert!(!buckets.accounts.contains_key("oldest@example.com"));
        }
        pending.failed();
        drop(new);
        let buckets = throttle.lock();
        assert_eq!(buckets.accounts["pending@example.com"].pending, 0);
        assert_eq!(buckets.accounts["pending@example.com"].failures, 1);
        assert_eq!(buckets.accounts.len(), MAX_KEYS - 1);
    }

    #[tokio::test(start_paused = true)]
    async fn full_account_map_keeps_all_pending_reservations_until_drop() {
        let throttle = SignInThrottle::default();
        let mut attempts = Vec::new();
        for n in 0..MAX_KEYS as u32 {
            let mut attempt = throttle.begin(IpAddr::from(n.to_be_bytes())).unwrap();
            attempt.account(format!("{n}@example.com")).unwrap();
            attempts.push(attempt);
        }
        tokio::time::advance(WINDOW).await;
        // Use an existing IP reservation so the Account map alone rejects admission.
        let mut rejected = throttle.begin(IpAddr::from(0u32.to_be_bytes())).unwrap();
        assert!(rejected.account("new@example.com".into()).is_err());
        assert_eq!(throttle.lock().accounts.len(), MAX_KEYS);
        assert_eq!(
            throttle.pending_counts(),
            (MAX_KEYS as u32 + 1, MAX_KEYS as u32)
        );
        drop(attempts.pop());
        rejected.account("new@example.com".into()).unwrap();
        assert_eq!(throttle.lock().accounts.len(), MAX_KEYS);
        drop((attempts, rejected));
        assert_eq!(throttle.pending_counts(), (0, 0));
        assert!(throttle.lock().accounts.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn expired_buckets_are_reclaimed_before_unexpired_history_in_both_maps() {
        let throttle = SignInThrottle::default();
        for n in 0..MAX_KEYS as u32 {
            let mut attempt = throttle.begin(IpAddr::from(n.to_be_bytes())).unwrap();
            attempt.account(format!("{n}@example.com")).unwrap();
            attempt.failed();
            if n == 1 {
                tokio::time::advance(Duration::from_millis(1)).await;
            }
        }
        tokio::time::advance(WINDOW - Duration::from_millis(1)).await;
        // Suppress the periodic sweep to exercise reclamation on insertion pressure.
        throttle.lock().last_prune = Some(Instant::now());
        let mut new = throttle.begin(ip(1)).unwrap();
        new.account("new@example.com".into()).unwrap();
        let buckets = throttle.lock();
        assert_eq!(buckets.ips.len(), MAX_KEYS - 1);
        assert_eq!(buckets.accounts.len(), MAX_KEYS - 1);
        for n in 0..MAX_KEYS as u32 {
            assert_eq!(
                buckets.ips.contains_key(&IpAddr::from(n.to_be_bytes())),
                n >= 2
            );
            assert_eq!(
                buckets.accounts.contains_key(&format!("{n}@example.com")),
                n >= 2
            );
        }
        drop(buckets);
        drop(new);
    }

    #[test]
    fn untrusted_or_malformed_forwarding_cannot_rotate_failure_budgets() {
        for (peer, repeated, invalid) in [
            ("172.30.94.1:1234", false, false),
            ("172.30.94.2:1234", true, false),
            ("172.30.94.2:1234", false, true),
        ] {
            let throttle =
                SignInThrottle::with_proxy_config(Some("172.30.94.2"), Some("x-forwarded-for"))
                    .unwrap();
            let peer = ConnectInfo(peer.parse().unwrap());
            for n in 1..=IP_LIMIT {
                let mut headers = HeaderMap::new();
                let value = if invalid {
                    format!("198.51.100.{n}, invalid")
                } else {
                    format!("198.51.100.{n}")
                };
                headers.append("x-forwarded-for", value.parse().unwrap());
                if repeated {
                    headers.append("x-forwarded-for", "203.0.113.1".parse().unwrap());
                }
                let ip = throttle.client_ip(peer, &headers);
                assert_eq!(ip, peer.0.ip());
                throttle.begin(ip).unwrap().failed();
            }
            assert!(
                throttle
                    .begin(throttle.client_ip(peer, &HeaderMap::new()))
                    .is_err()
            );
            assert!(throttle.begin("203.0.113.99".parse().unwrap()).is_ok());
        }
    }
}
