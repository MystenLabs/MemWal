//! Delegate public keys in `MEMWAL_LEAKED_DELEGATE_PUBLIC_KEYS`.
//!
//! The binary and the library both compile `oauth`, so this check lives
//! here rather than under `routes`. `0x` and case do not matter. An empty
//! list revokes nothing.

use std::collections::HashSet;

pub fn normalize_hex(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X")
        .to_ascii_lowercase()
}

/// Split a comma- or whitespace-separated hex list.
pub fn parse_hex_set(raw: &str) -> HashSet<String> {
    raw.split(|c: char| c == ',' || c == '\n' || c.is_whitespace())
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(normalize_hex)
        .filter(|part| !part.is_empty())
        .collect()
}

pub fn from_env() -> HashSet<String> {
    std::env::var("MEMWAL_LEAKED_DELEGATE_PUBLIC_KEYS")
        .ok()
        .map(|raw| parse_hex_set(&raw))
        .unwrap_or_default()
}

pub fn is_leaked_delegate_public_key(public_key_hex: &str) -> bool {
    let key = normalize_hex(public_key_hex);
    !key.is_empty() && from_env().contains(&key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_leaked_public_key_matches_with_or_without_the_prefix() {
        let leaked = parse_hex_set("0xAaBbcc");
        let hit = |key: &str| {
            let key = normalize_hex(key);
            !key.is_empty() && leaked.contains(&key)
        };
        assert!(hit("aabbcc"));
        assert!(hit("0xAABBCC"));
        assert!(!hit("ddeeff"));
        assert!(!hit(""));
    }
}
