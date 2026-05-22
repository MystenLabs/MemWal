"""
memwal — Shared Utilities

Crypto and encoding helpers for Ed25519 signing and SHA-256 hashing.
Uses PyNaCl (nacl.signing) as the primary Ed25519 implementation.
"""

from __future__ import annotations

import base64
import hashlib
from datetime import datetime, timezone
from typing import Tuple

import nacl.signing

_BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_SUI_ED25519_SCHEME_FLAG = 0


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
    nonce: str = "",
    account_id: str = "",
) -> str:
    """Build the canonical signing message.

    Current format (matches Rust server ``services/server/src/auth.rs``)::

        "{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}.{account_id}"

    The trailing ``nonce`` was added in MED-1 (replay protection); the
    ``account_id`` was added in LOW-23 so an intermediary can't swap the
    account hint without invalidating the signature. Both fields are
    REQUIRED — passing empty strings will fail signature verification on
    the server.

    Args:
        timestamp: Unix seconds as string.
        method: Uppercase HTTP method (e.g. ``"POST"``).
        path: URL path with query (e.g. ``"/api/remember"``).
        body_sha256: SHA-256 hex digest of the JSON body string.
        nonce: UUID v4 sent as the ``x-nonce`` header (required).
        account_id: MemWalAccount object ID sent as ``x-account-id``
            (required; empty string here will mismatch on server).
    """
    return f"{timestamp}.{method}.{path}.{body_sha256}.{nonce}.{account_id}"


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


def _bech32_polymod(values: bytes) -> int:
    generators = [
        0x3B6A57B2,
        0x26508E6D,
        0x1EA119FA,
        0x3D4233DD,
        0x2A1462B3,
    ]
    chk = 1
    for value in values:
        top = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ value
        for i in range(5):
            if (top >> i) & 1:
                chk ^= generators[i]
    return chk


def _bech32_hrp_expand(hrp: str) -> bytes:
    return bytes([ord(x) >> 5 for x in hrp] + [0] + [ord(x) & 31 for x in hrp])


def _bech32_create_checksum(hrp: str, data: bytes) -> bytes:
    values = _bech32_hrp_expand(hrp) + data
    polymod = _bech32_polymod(values + bytes(6)) ^ 1
    return bytes((polymod >> 5 * (5 - i)) & 31 for i in range(6))


def _convertbits(data: bytes, frombits: int, tobits: int, pad: bool = True) -> bytes:
    acc = 0
    bits = 0
    ret = []
    maxv = (1 << tobits) - 1
    max_acc = (1 << (frombits + tobits - 1)) - 1
    for value in data:
        if value < 0 or value >> frombits:
            raise ValueError("invalid value for convertbits")
        acc = ((acc << frombits) | value) & max_acc
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if pad:
        if bits:
            ret.append((acc << (tobits - bits)) & maxv)
    elif bits >= frombits or ((acc << (tobits - bits)) & maxv):
        raise ValueError("invalid incomplete group for convertbits")
    return bytes(ret)


def bech32_encode(hrp: str, data: bytes) -> str:
    combined = data + _bech32_create_checksum(hrp, data)
    return hrp + "1" + "".join(_BECH32_CHARSET[d] for d in combined)


def encode_sui_private_key(seed_bytes: bytes) -> str:
    """Encode a 32-byte Ed25519 seed to Sui bech32 `suiprivkey...` format."""
    if len(seed_bytes) != 32:
        raise ValueError(f"Ed25519 seed must be exactly 32 bytes, got {len(seed_bytes)}")
    payload = bytes([_SUI_ED25519_SCHEME_FLAG]) + seed_bytes
    return bech32_encode("suiprivkey", _convertbits(payload, 8, 5))


def uleb128_encode(value: int) -> bytes:
    """Encode an integer using ULEB128."""
    if value < 0:
        raise ValueError("ULEB128 only supports non-negative integers")
    encoded = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            encoded.append(byte | 0x80)
        else:
            encoded.append(byte)
            return bytes(encoded)


def serialize_bcs_byte_vector(value: bytes) -> bytes:
    """BCS `vector<u8>` encoding: ULEB128 length prefix followed by bytes."""
    return uleb128_encode(len(value)) + value


def build_seal_session_personal_message(
    package_id: str,
    ttl_min: int,
    creation_time_ms: int,
    session_public_key_bytes: bytes,
) -> bytes:
    """Build the SEAL SessionKey personal message string expected by Mysten SEAL."""
    creation_time_utc = datetime.fromtimestamp(
        creation_time_ms / 1000, tz=timezone.utc
    ).strftime("%Y-%m-%d %H:%M:%S UTC")
    session_public_key_b64 = base64.b64encode(session_public_key_bytes).decode("ascii")
    message = (
        f"Accessing keys of package {package_id} for {ttl_min} mins from "
        f"{creation_time_utc}, session key {session_public_key_b64}"
    )
    return message.encode("utf-8")


def sign_sui_personal_message(
    message: bytes, signing_key: nacl.signing.SigningKey
) -> str:
    """Sign a Sui PersonalMessage and return serialized base64 signature."""
    intent_message = b"\x03\x00\x00" + serialize_bcs_byte_vector(message)
    digest = hashlib.blake2b(intent_message, digest_size=32).digest()
    signature_bytes = signing_key.sign(digest).signature
    public_key_bytes = bytes(signing_key.verify_key)
    serialized = bytes([_SUI_ED25519_SCHEME_FLAG]) + signature_bytes + public_key_bytes
    return base64.b64encode(serialized).decode("ascii")
