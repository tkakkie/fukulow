use super::{ConnectInfo, HeaderMap, IpAddr, SocketAddr};
use crate::auth::SignInThrottle;

fn ip(n: u8) -> IpAddr {
    IpAddr::from([192, 0, 2, n])
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
        ("::/0", "2001:db8::1", "192.0.2.99"),
        ("::/64", "::1", "192.0.2.99"),
        ("::ffff:192.0.2.0/120", "::ffff:192.0.2.99", "192.0.3.1"),
        ("::ffff:192.0.2.0/80", "::1", "192.0.2.99"),
        ("::ffff:10.0.0.0/104", "10.2.3.4", "11.2.3.4"),
        ("::ffff:0:0/96", "10.2.3.4", "2001:db8::1"),
        ("10.0.0.0/8", "::ffff:10.2.3.4", "11.2.3.4"),
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
fn ipv6_proxy_ranges_do_not_trust_ipv4_peers() {
    let mut headers = HeaderMap::new();
    headers.insert("x-forwarded-for", "198.51.100.99".parse().unwrap());
    let mut incorrectly_trusted = Vec::new();
    for network in ["::/0", "::/64", "::ffff:10.0.0.0/80", "::ffff:10.0.0.0/95"] {
        let throttle =
            SignInThrottle::with_proxy_config(Some(network), Some("x-forwarded-for")).unwrap();
        for address in ["10.2.3.4", "::ffff:10.2.3.4"] {
            let peer = ConnectInfo(SocketAddr::new(address.parse().unwrap(), 1234));
            if throttle.client_ip(peer, &headers) != peer.0.ip().to_canonical() {
                incorrectly_trusted.push((network, address));
            }
        }
    }
    assert!(incorrectly_trusted.is_empty(), "{incorrectly_trusted:?}");
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
        (Some("192.0.2.0/+24"), Some("x-forwarded-for")),
        (Some("192.0.2.0/024"), Some("x-forwarded-for")),
        (Some("2001:db8::/+24"), Some("x-forwarded-for")),
        (Some("2001:db8::/024"), Some("x-forwarded-for")),
        (Some("192.0.2.0/24/1"), Some("x-forwarded-for")),
        (Some("192.0.2.1,"), Some("x-forwarded-for")),
        (Some("192.0.2.1"), Some("")),
        (Some("192.0.2.1"), Some("bad header")),
    ] {
        assert!(SignInThrottle::with_proxy_config(peers, header).is_err());
    }
}
