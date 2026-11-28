use std::net::{IpAddr, SocketAddr};

use axum::{
    extract::ConnectInfo,
    http::{HeaderMap, HeaderName},
};

#[derive(Clone, Default)]
pub(super) struct ClientIp {
    proxy: Option<(HeaderName, Vec<ProxyNetwork>)>,
}

impl ClientIp {
    pub(super) fn from_config(
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
        Ok(Self { proxy })
    }

    pub(super) fn select(&self, peer: ConnectInfo<SocketAddr>, headers: &HeaderMap) -> IpAddr {
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
            Some((address, prefix)) => {
                let parsed = prefix.parse::<u8>().map_err(|_| ERROR)?;
                if prefix != parsed.to_string() {
                    return Err(ERROR);
                }
                (address, Some(parsed))
            }
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
            (IpAddr::V6(address), IpAddr::V4(peer))
                if self.prefix >= 96 && address.to_ipv4_mapped().is_some() =>
            {
                (u128::from(address), u128::from(peer.to_ipv6_mapped()), 128)
            }
            _ => return false,
        };
        self.prefix == 0 || address >> (bits - self.prefix) == peer >> (bits - self.prefix)
    }
}

#[cfg(test)]
mod tests;
