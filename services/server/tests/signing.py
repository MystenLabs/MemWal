"""Shared Ed25519 request-signing helper for the relayer's Python test suites.

Server-side payload format (services/server/src/auth.rs):
    "{timestamp}.{method}.{path}.{body_hash}.{nonce}.{account_id}"

Empty account_id is signed as the empty string when no x-account-id is sent.
"""
import hashlib

from nacl.encoding import RawEncoder
from nacl.signing import SigningKey


def sign_request(
    signing_key: SigningKey,
    method: str,
    path: str,
    body_bytes: bytes,
    timestamp: str,
    nonce: str,
    account_id: str,
) -> str:
    """Return the hex-encoded Ed25519 signature over the canonical message."""
    body_hash = hashlib.sha256(body_bytes).hexdigest()
    message = f"{timestamp}.{method}.{path}.{body_hash}.{nonce}.{account_id}".encode()
    signed = signing_key.sign(message, encoder=RawEncoder)
    return signed.signature.hex()
