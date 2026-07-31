//! Canonical client-IP extraction behind an explicitly configured proxy chain.
//!
//! `X-Forwarded-For` is attacker-controlled unless every hop between the
//! relayer and the caller is known. The safe default therefore trusts zero
//! proxy hops and uses only the TCP peer address.

use axum::http::HeaderMap;
use std::net::{IpAddr, SocketAddr};

/// Resolve the client IP from the right-hand (trusted) side of the forwarding
/// chain. `trusted_proxy_hops = 0` ignores XFF entirely. A value of `1` means
/// the direct peer is a trusted proxy and its right-most XFF entry is the
/// client. If the selected entry is malformed or the chain is too short, fall
/// back to the direct peer without shifting trust to another entry.
pub fn canonical_client_ip(
    headers: &HeaderMap,
    peer: SocketAddr,
    trusted_proxy_hops: usize,
) -> IpAddr {
    let peer_ip = peer.ip();
    if trusted_proxy_hops == 0 {
        return peer_ip;
    }

    let mut forwarded = Vec::new();
    for value in headers.get_all("x-forwarded-for") {
        let Ok(value) = value.to_str() else {
            return peer_ip;
        };
        // Preserve empty/malformed positions: dropping one could shift a
        // spoofed entry into the trusted slot. The selected slot is parsed
        // below and any invalid value falls back to the direct peer.
        forwarded.extend(value.split(',').map(str::trim));
    }

    forwarded
        .len()
        .checked_sub(trusted_proxy_hops)
        .and_then(|index| forwarded.get(index))
        .and_then(|candidate| candidate.parse::<IpAddr>().ok())
        .unwrap_or(peer_ip)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(xff: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(value) = xff {
            headers.insert("x-forwarded-for", HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    #[test]
    fn zero_trusted_hops_ignores_spoofed_xff() {
        let peer = "203.0.113.9:443".parse().unwrap();
        assert_eq!(
            canonical_client_ip(&headers(Some("198.51.100.7")), peer, 0),
            "203.0.113.9".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn one_trusted_proxy_selects_from_the_right() {
        let peer = "10.0.0.5:443".parse().unwrap();
        assert_eq!(
            canonical_client_ip(&headers(Some("198.51.100.7")), peer, 1),
            "198.51.100.7".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn attacker_prepended_values_do_not_change_selected_client() {
        let peer = "10.0.0.5:443".parse().unwrap();
        assert_eq!(
            canonical_client_ip(
                &headers(Some("192.0.2.66, 192.0.2.67, 198.51.100.7")),
                peer,
                1,
            ),
            "198.51.100.7".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn malformed_prepended_entries_do_not_change_selected_client() {
        let peer = "10.0.0.5:443".parse().unwrap();
        let resolved = canonical_client_ip(&headers(Some("not-an-ip, 198.51.100.7")), peer, 1);
        assert_eq!(resolved, "198.51.100.7".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn malformed_selected_hop_falls_back_to_direct_peer() {
        let peer = "10.0.0.5:443".parse().unwrap();
        assert_eq!(
            canonical_client_ip(&headers(Some("198.51.100.7, also-invalid")), peer, 1),
            peer.ip()
        );
    }

    #[test]
    fn ipv6_is_supported() {
        let peer = "[2001:db8::2]:443".parse().unwrap();
        assert_eq!(
            canonical_client_ip(&headers(Some("2001:db8::1")), peer, 1),
            "2001:db8::1".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn insufficient_chain_falls_back_to_direct_peer() {
        let peer = "10.0.0.5:443".parse().unwrap();
        assert_eq!(
            canonical_client_ip(&headers(Some("198.51.100.7")), peer, 2),
            peer.ip()
        );
    }
}
