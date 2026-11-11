use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use axum::{
    extract::ConnectInfo,
    http::{HeaderMap, HeaderName},
};
use tokio::time::Instant;

const WINDOW: Duration = Duration::from_secs(60);
const IP_LIMIT: u32 = 20;
const ACCOUNT_LIMIT: u32 = 5;
const MAX_KEYS: usize = 10_000;

type Account = String;

#[derive(Clone, Default)]
pub struct SignInThrottle {
    buckets: Arc<Mutex<Buckets>>,
    proxy: Option<(HeaderName, Vec<ProxyNetwork>)>,
}

#[derive(Clone)]
struct ProxyNetwork {
    address: IpAddr,
    prefix: u8,
}

impl ProxyNetwork {
    fn parse(value: &str) -> Result<Self, &'static str> {
        const ERROR: &str =
            "FUKULOW_TRUSTED_PROXIES must contain comma-separated IP addresses or CIDRs";
        let (address, prefix) = match value.split_once('/') {
            Some((address, prefix)) => (address, Some(prefix.parse::<u8>().map_err(|_| ERROR)?)),
            None => (value, None),
        };
        let address = address.parse::<IpAddr>().map_err(|_| ERROR)?;
        let bits = if address.is_ipv4() { 32 } else { 128 };
        let prefix = prefix.unwrap_or(bits);
        if prefix > bits {
            return Err(ERROR);
        }
        Ok(Self { address, prefix })
    }

    fn contains(&self, peer: IpAddr) -> bool {
        let peer = peer.to_canonical();
        let (address, peer, bits) = match (self.address, peer) {
            (IpAddr::V4(address), IpAddr::V4(peer)) => {
                (u32::from(address) as u128, u32::from(peer) as u128, 32)
            }
            (IpAddr::V6(address), IpAddr::V6(peer)) => (u128::from(address), u128::from(peer), 128),
            (IpAddr::V6(address), IpAddr::V4(peer)) => {
                (u128::from(address), u128::from(peer.to_ipv6_mapped()), 128)
            }
            _ => return false,
        };
        self.prefix == 0 || address >> (bits - self.prefix) == peer >> (bits - self.prefix)
    }
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

fn reserve<K: Eq + std::hash::Hash>(
    buckets: &mut HashMap<K, Bucket>,
    key: K,
    limit: u32,
    now: Instant,
) -> Result<(), Duration> {
    if !buckets.contains_key(&key) && buckets.len() >= MAX_KEYS {
        return Err(WINDOW);
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
    /// Proxy peer IPs/CIDRs, plus a header whose rightmost value is the client IP.
    /// Both settings must be present; the default trusts no forwarded headers.
    pub fn with_proxy_config(
        peers: Option<&str>,
        header: Option<&str>,
    ) -> Result<Self, &'static str> {
        let proxy = match (peers, header) {
            (None, None) => None,
            (Some(peers), Some(header)) => {
                let peers = peers
                    .split(',')
                    .map(|ip| ProxyNetwork::parse(ip.trim()))
                    .collect::<Result<Vec<_>, _>>()?;
                let header = HeaderName::from_bytes(header.as_bytes())
                    .map_err(|_| "FUKULOW_CLIENT_IP_HEADER must be a nonempty HTTP header name")?;
                Some((header, peers))
            }
            _ => {
                return Err(
                    "configure FUKULOW_TRUSTED_PROXIES and FUKULOW_CLIENT_IP_HEADER together",
                );
            }
        };
        Ok(Self {
            proxy,
            ..Self::default()
        })
    }

    pub(super) fn client_ip(&self, peer: ConnectInfo<SocketAddr>, headers: &HeaderMap) -> IpAddr {
        let peer = peer.0.ip().to_canonical();
        if let Some((header, trusted)) = &self.proxy
            && trusted.iter().any(|network| network.contains(peer))
        {
            let mut values = headers.get_all(header).iter();
            if let Some(value) = values.next()
                && values.next().is_none()
                && let Ok(value) = value.to_str()
                && let Some(ip) = value.rsplit(',').next()
                && let Ok(ip) = ip.trim().parse::<IpAddr>()
            {
                // Caddy/nginx append or overwrite with their immediate client's IP.
                return ip.to_canonical();
            }
        }
        peer
    }

    fn lock(&self) -> MutexGuard<'_, Buckets> {
        self.buckets
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
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
        if !buckets.ips.contains_key(&ip) && buckets.ips.len() >= MAX_KEYS {
            // Never evict a reservation: its eventual Drop must release this bucket.
            let oldest = buckets
                .ips
                .iter()
                .filter(|(_, bucket)| bucket.pending == 0)
                .min_by_key(|(_, bucket)| bucket.expires)
                .map(|(key, _)| *key);
            if let Some(key) = oldest {
                buckets.ips.remove(&key);
            }
        }
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
        let account = self
            .account
            .as_ref()
            .and_then(|key| buckets.accounts.get_mut(key));
        if let Some(bucket) = account {
            finish(bucket, self.failed);
        }
        if let Some(bucket) = buckets.ips.get_mut(&self.ip) {
            finish(bucket, self.failed);
            if bucket.failures == 0 && bucket.pending == 0 {
                buckets.ips.remove(&self.ip);
            }
        }
    }
}

fn finish(bucket: &mut Bucket, failed: bool) {
    bucket.pending -= 1;
    if failed {
        bucket.refresh(Instant::now());
        bucket.failures += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(n: u8) -> IpAddr {
        IpAddr::from([192, 0, 2, n])
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
        let password = "correct horse battery staple";
        let stored = crate::auth::hash_password(password.into(), &crate::auth::PASSWORD_WORKERS)
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
                &crate::auth::PASSWORD_WORKERS
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
            let mut attempt = throttle.begin(ip(1)).unwrap();
            attempt.account(format!("{n}@example.com")).unwrap();
        }
        let mut rejected = throttle.begin(ip(1)).unwrap();
        assert!(rejected.account("overflow@example.com".into()).is_err());
        assert_eq!(throttle.lock().accounts.len(), MAX_KEYS);
        drop(rejected);
        assert!(throttle.lock().ips.is_empty());
        tokio::time::advance(WINDOW).await;
        let mut allowed = throttle.begin(ip(1)).unwrap();
        allowed.account("overflow@example.com".into()).unwrap();
        assert_eq!(throttle.lock().accounts.len(), 1);
    }

    #[test]
    fn forwarded_ip_requires_configured_header_and_trusted_peer() {
        let peer = ConnectInfo("192.0.2.1:1234".parse().unwrap());
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            "198.51.100.99, 203.0.113.7".parse().unwrap(),
        );
        let default = SignInThrottle::default();
        assert_eq!(default.client_ip(peer, &headers), ip(1));
        let trusted =
            SignInThrottle::with_proxy_config(Some("192.0.2.1"), Some("x-forwarded-for")).unwrap();
        assert_eq!(
            trusted.client_ip(peer, &headers),
            "203.0.113.7".parse::<IpAddr>().unwrap()
        );
        let untrusted = ConnectInfo("192.0.2.2:1234".parse().unwrap());
        assert_eq!(trusted.client_ip(untrusted, &headers), ip(2));
        for value in [
            "invalid",
            "198.51.100.99, invalid",
            "",
            "198.51.100.99:1234",
        ] {
            headers.insert("x-forwarded-for", value.parse().unwrap());
            assert_eq!(trusted.client_ip(peer, &headers), ip(1));
        }
        headers.clear();
        assert_eq!(trusted.client_ip(peer, &headers), ip(1));
        headers.append("x-forwarded-for", "198.51.100.99".parse().unwrap());
        headers.append("x-forwarded-for", "203.0.113.7".parse().unwrap());
        assert_eq!(trusted.client_ip(peer, &headers), ip(1));
        let mapped = ConnectInfo("[::ffff:192.0.2.1]:1234".parse().unwrap());
        headers.insert("x-forwarded-for", "::ffff:203.0.113.7".parse().unwrap());
        assert_eq!(
            trusted.client_ip(mapped, &headers),
            "203.0.113.7".parse::<IpAddr>().unwrap()
        );
        let custom =
            SignInThrottle::with_proxy_config(Some("192.0.2.1, ::1"), Some("x-real-ip")).unwrap();
        headers.insert("x-real-ip", "203.0.113.8".parse().unwrap());
        assert_eq!(
            custom.client_ip(peer, &headers),
            "203.0.113.8".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn proxy_cidrs_match_only_peers_in_the_configured_networks() {
        for (network, allowed, denied) in [
            ("192.0.2.65/26", "192.0.2.127", "192.0.2.128"),
            ("192.0.2.1/32", "192.0.2.1", "192.0.2.2"),
            ("0.0.0.0/0", "203.0.113.1", "2001:db8::1"),
            ("2001:db8:1::1/48", "2001:db8:1:ffff::1", "2001:db8:2::1"),
            ("2001:db8::1/128", "2001:db8::1", "2001:db8::2"),
            ("::/0", "2001:db8::1", ""),
            ("::ffff:192.0.2.0/120", "::ffff:192.0.2.99", "192.0.3.1"),
            ("::ffff:192.0.2.0/80", "192.0.2.99", "2001:db8::1"),
            ("::ffff:192.0.2.1", "192.0.2.1", "192.0.2.2"),
            ("172.30.94.2", "172.30.94.2", "172.30.94.1"),
        ] {
            let throttle =
                SignInThrottle::with_proxy_config(Some(network), Some("x-forwarded-for")).unwrap();
            let mut headers = HeaderMap::new();
            headers.insert("x-forwarded-for", "198.51.100.99".parse().unwrap());
            let peer = |ip: &str| ConnectInfo(SocketAddr::new(ip.parse().unwrap(), 1234));
            assert_eq!(
                throttle.client_ip(peer(allowed), &headers),
                "198.51.100.99".parse::<IpAddr>().unwrap(),
                "{network}"
            );
            if !denied.is_empty() {
                assert_eq!(
                    throttle.client_ip(peer(denied), &headers),
                    denied.parse::<IpAddr>().unwrap(),
                    "{network}"
                );
            }
        }
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

    #[test]
    fn proxy_configuration_rejects_partial_or_invalid_settings() {
        for (peers, header) in [
            (Some("192.0.2.1"), None),
            (None, Some("x-forwarded-for")),
            (Some(""), Some("x-forwarded-for")),
            (Some("192.0.2.0/33"), Some("x-forwarded-for")),
            (Some("2001:db8::/129"), Some("x-forwarded-for")),
            (Some("192.0.2.0/-1"), Some("x-forwarded-for")),
            (Some("192.0.2.0/24/1"), Some("x-forwarded-for")),
            (Some("192.0.2.1,"), Some("x-forwarded-for")),
            (Some("192.0.2.1"), Some("")),
            (Some("192.0.2.1"), Some("bad header")),
        ] {
            assert!(SignInThrottle::with_proxy_config(peers, header).is_err());
        }
    }
}
