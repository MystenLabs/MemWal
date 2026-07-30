//! Trusted-proxy-aware client IP resolution.
//!
//! `X-Forwarded-For` grows left→right: every reverse proxy **appends** the
//! address it received the connection from. So the rightmost entries are the
//! closest (trusted) hops we control and the leftmost entry is whatever the
//! original — possibly malicious — client chose to send. Taking the leftmost
//! value (the historical behavior) let any client forge its own rate-limit
//! bucket by sending a fresh fake `X-Forwarded-For` each request. See
//! GitHub issue #360.
//!
//! [`resolve_client_ip`] mirrors express's numeric `trust proxy` semantics:
//! it counts a configured number of trusted hops in from the socket end and
//! returns the first address the client could not have forged.

use std::net::IpAddr;

/// Resolve the real client IP from an inbound `X-Forwarded-For` header value
/// and the direct socket peer, trusting exactly `trusted_hops` reverse
/// proxies in front of this server.
///
/// The address chain is built nearest-hop-first as `[peer, xff reversed…]`
/// (index 0 = the hop that physically opened the connection to us). We then
/// return the address `trusted_hops` positions in — i.e. we skip that many
/// trusted proxies and take the next address, which is the furthest-out
/// address we still trust.
///
/// * `trusted_hops = 0` → ignore `X-Forwarded-For` entirely and use the raw
///   socket peer. Safe default for a directly-exposed server: nothing the
///   client sends is trusted.
/// * `trusted_hops = 1` → one reverse proxy in front (e.g. Railway's edge).
///   Returns the address that edge observed for the client, which a client
///   cannot forge past because edge always appends the true socket address to
///   the right of any client-supplied value.
///
/// If `trusted_hops` exceeds the real chain length (misconfiguration) the
/// index is clamped to the leftmost (oldest) address — the best we can see —
/// so a too-large hop count degrades gracefully rather than panicking. Set
/// `trusted_hops` to the *actual* number of proxies in front of the relayer;
/// a value larger than reality re-opens the spoofing hole.
///
/// Returns `None` only when there is neither a socket peer nor any usable
/// `X-Forwarded-For` entry.
pub fn resolve_client_ip(
    xff: Option<&str>,
    peer: Option<IpAddr>,
    trusted_hops: usize,
) -> Option<String> {
    // Address chain, nearest hop first: the socket peer, then the XFF entries
    // in reverse (rightmost = most-recently-appended = nearest hop).
    let mut chain: Vec<&str> = Vec::new();
    let peer_str;
    if let Some(p) = peer {
        peer_str = p.to_string();
        chain.push(&peer_str);
    }
    if let Some(raw) = xff {
        for entry in raw.split(',').rev() {
            let trimmed = entry.trim();
            if !trimmed.is_empty() {
                chain.push(trimmed);
            }
        }
    }

    if chain.is_empty() {
        return None;
    }

    // Skip `trusted_hops` trusted proxies from the near end; clamp so a
    // misconfigured (too-large) hop count can never index past the chain.
    let idx = trusted_hops.min(chain.len() - 1);
    Some(chain[idx].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn zero_hops_ignores_xff_and_uses_socket_peer() {
        // A directly-exposed server must never trust a client-supplied header.
        let got = resolve_client_ip(Some("1.2.3.4"), Some(ip("203.0.113.7")), 0);
        assert_eq!(got.as_deref(), Some("203.0.113.7"));
    }

    #[test]
    fn one_hop_returns_edge_observed_client_not_spoof() {
        // Attacker sends `X-Forwarded-For: 1.2.3.4`; the edge proxy appends the
        // real socket address (203.0.113.9); our socket peer is the edge's
        // internal address (10.0.0.1). With one trusted hop we must land on the
        // real client, never the spoofed leftmost value.
        let got = resolve_client_ip(
            Some("1.2.3.4, 203.0.113.9"),
            Some(ip("10.0.0.1")),
            1,
        );
        assert_eq!(got.as_deref(), Some("203.0.113.9"));
    }

    #[test]
    fn one_hop_no_client_xff_returns_client() {
        // Honest client sends no XFF; edge appends its real address.
        let got = resolve_client_ip(Some("203.0.113.9"), Some(ip("10.0.0.1")), 1);
        assert_eq!(got.as_deref(), Some("203.0.113.9"));
    }

    #[test]
    fn two_hops_peels_two_trusted_proxies() {
        // chain (near→far): [proxyB(peer), proxyA, realclient, spoof]
        let got = resolve_client_ip(
            Some("9.9.9.9, 203.0.113.9, 10.0.0.2"),
            Some(ip("10.0.0.1")),
            2,
        );
        assert_eq!(got.as_deref(), Some("203.0.113.9"));
    }

    #[test]
    fn hops_larger_than_chain_clamps_to_oldest() {
        // Misconfiguration: more trusted hops than addresses. Clamp to the
        // leftmost known address rather than panic / underflow.
        let got = resolve_client_ip(Some("203.0.113.9"), Some(ip("10.0.0.1")), 9);
        assert_eq!(got.as_deref(), Some("203.0.113.9"));
    }

    #[test]
    fn no_xff_falls_back_to_peer() {
        let got = resolve_client_ip(None, Some(ip("203.0.113.7")), 1);
        assert_eq!(got.as_deref(), Some("203.0.113.7"));
    }

    #[test]
    fn whitespace_and_empty_entries_are_skipped() {
        let got = resolve_client_ip(Some("  , 203.0.113.9 ,  "), Some(ip("10.0.0.1")), 1);
        assert_eq!(got.as_deref(), Some("203.0.113.9"));
    }

    #[test]
    fn ipv6_peer_and_entries() {
        let got = resolve_client_ip(
            Some("2001:db8::5, 2001:db8::9"),
            Some(ip("2001:db8::1")),
            1,
        );
        assert_eq!(got.as_deref(), Some("2001:db8::9"));
    }

    #[test]
    fn no_peer_uses_xff_only() {
        // Defensive: no ConnectInfo available (should not happen in prod).
        let got = resolve_client_ip(Some("1.2.3.4, 203.0.113.9"), None, 1);
        assert_eq!(got.as_deref(), Some("1.2.3.4"));
    }

    #[test]
    fn nothing_available_returns_none() {
        assert_eq!(resolve_client_ip(None, None, 1), None);
        assert_eq!(resolve_client_ip(Some("   "), None, 1), None);
    }
}
