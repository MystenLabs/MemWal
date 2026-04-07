"""
memwal — Shared Utilities

Crypto and encoding helpers for Ed25519 signing and SHA-256 hashing.
Uses PyNaCl (nacl.signing) as the primary Ed25519 implementation.
"""

from __future__ import annotations

import hashlib
from typing import Tuple

import nacl.signing


def hex_to_bytes(hex_str: str) -> bytes:
    """Convert a hex string to bytes.

    Handles optional ``0x`` prefix.

    Args:
        hex_str: Hex-encoded string, optionally prefixed with ``0x``.

    Returns:
        Raw bytes.
    """
    clean = hex_str[2:] if hex_str.startswith("0x") else hex_str
    return bytes.fromhex(clean)


def bytes_to_hex(b: bytes) -> str:
    """Convert bytes to a lowercase hex string (no ``0x`` prefix).

    Args:
        b: Raw bytes.

    Returns:
        Hex-encoded string.
    """
    return b.hex()


def sha256_hex(data: str) -> str:
    """Compute the SHA-256 hex digest of a UTF-8 string.

    Args:
        data: Input string.

    Returns:
        Lowercase hex SHA-256 digest.
    """
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def build_signing_key(private_key_hex: str) -> nacl.signing.SigningKey:
    """Build a PyNaCl ``SigningKey`` from an Ed25519 private key hex string.

    Args:
        private_key_hex: 32-byte Ed25519 seed as hex (64 hex chars), optionally ``0x``-prefixed.

    Returns:
        A ``nacl.signing.SigningKey`` instance.

    Raises:
        ValueError: If the decoded seed is not exactly 32 bytes.
    """
    seed_bytes = hex_to_bytes(private_key_hex)
    if len(seed_bytes) != 32:
        raise ValueError(
            f"Ed25519 seed must be exactly 32 bytes, got {len(seed_bytes)}"
        )
    return nacl.signing.SigningKey(seed_bytes)


def sign_message(message: str, signing_key: nacl.signing.SigningKey) -> Tuple[str, str]:
    """Sign a UTF-8 message with an Ed25519 signing key.

    Args:
        message: The message string to sign.
        signing_key: A PyNaCl ``SigningKey``.

    Returns:
        A tuple of ``(signature_hex, public_key_hex)``.
    """
    signed = signing_key.sign(message.encode("utf-8"))
    signature_bytes: bytes = signed.signature
    public_key_bytes: bytes = bytes(signing_key.verify_key)
    return bytes_to_hex(signature_bytes), bytes_to_hex(public_key_bytes)


def build_signature_message(
    timestamp: str,
    method: str,
    path: str,
    body_sha256: str,
) -> str:
    """Build the canonical signing message.

    Format: ``{timestamp}.{method}.{path}.{body_sha256}``

    Args:
        timestamp: Unix seconds as string.
        method: Uppercase HTTP method (e.g. ``"POST"``).
        path: URL path (e.g. ``"/api/remember"``).
        body_sha256: SHA-256 hex digest of the JSON body string.

    Returns:
        The message string to sign.
    """
    return f"{timestamp}.{method}.{path}.{body_sha256}"


def delegate_key_to_sui_address(private_key_hex: str) -> str:
    """Derive the Sui address from an Ed25519 delegate key.

    Sui Ed25519 address derivation:
        blake2b-256(0x00 || public_key)[0:32]

    where ``0x00`` is the Ed25519 scheme flag byte.

    This matches the TypeScript SDK's ``delegateKeyToSuiAddress()`` exactly,
    and is the same derivation used by the Sui wallet.

    Args:
        private_key_hex: Ed25519 private key as hex (64 hex chars / 32 bytes),
            optionally ``0x``-prefixed.

    Returns:
        Sui address as a ``0x``-prefixed lowercase hex string (32 bytes / 64 hex chars).

    Example::

        address = delegate_key_to_sui_address("944aa24c09d8b6d6...")
        # "0x1a2b3c..."
    """
    signing_key = build_signing_key(private_key_hex)
    public_key_bytes = bytes(signing_key.verify_key)  # 32 bytes

    # Sui scheme flag for Ed25519 = 0x00, then the 32-byte public key
    scheme_input = bytes([0x00]) + public_key_bytes  # 33 bytes total

    # blake2b with 32-byte (256-bit) digest
    address_bytes = hashlib.blake2b(scheme_input, digest_size=32).digest()
    return "0x" + bytes_to_hex(address_bytes)


def delegate_key_to_public_key(private_key_hex: str) -> bytes:
    """Get the Ed25519 public key bytes from a delegate key.

    Args:
        private_key_hex: Ed25519 private key as hex, optionally ``0x``-prefixed.

    Returns:
        32-byte Ed25519 public key.

    Example::

        pub = delegate_key_to_public_key("944aa24c...")
        print(pub.hex())  # "d5b76c57..."
    """
    signing_key = build_signing_key(private_key_hex)
    return bytes(signing_key.verify_key)
