"""
Tests for Ed25519 signing utilities.

Validates that:
1. build_signing_key produces a valid keypair from hex
2. sign_message produces a verifiable Ed25519 signature
3. The signature message format matches the server expectation exactly
"""

import hashlib
import json

import nacl.signing

from memwal.utils import (
    build_signature_message,
    build_signing_key,
    bytes_to_hex,
    hex_to_bytes,
    sha256_hex,
    sign_message,
)


class TestHexConversion:
    """Tests for hex_to_bytes and bytes_to_hex."""

    def test_round_trip(self) -> None:
        original = b"\x00\x01\x02\xff"
        assert hex_to_bytes(bytes_to_hex(original)) == original

    def test_hex_to_bytes_strips_0x_prefix(self) -> None:
        assert hex_to_bytes("0xdeadbeef") == bytes.fromhex("deadbeef")

    def test_hex_to_bytes_no_prefix(self) -> None:
        assert hex_to_bytes("deadbeef") == bytes.fromhex("deadbeef")

    def test_bytes_to_hex_lowercase(self) -> None:
        assert bytes_to_hex(b"\xDE\xAD") == "dead"


class TestSha256Hex:
    """Tests for sha256_hex."""

    def test_empty_string(self) -> None:
        expected = hashlib.sha256(b"").hexdigest()
        assert sha256_hex("") == expected

    def test_known_value(self) -> None:
        # SHA-256 of "hello" is well-known
        expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        assert sha256_hex("hello") == expected

    def test_json_body(self) -> None:
        """Verify sha256 works correctly on a JSON string (the actual use case)."""
        body = json.dumps({"text": "I love coffee", "namespace": "default"}, separators=(",", ":"))
        result = sha256_hex(body)
        assert len(result) == 64
        assert all(c in "0123456789abcdef" for c in result)


class TestBuildSigningKey:
    """Tests for build_signing_key."""

    def test_produces_valid_keypair(self) -> None:
        # Generate a fresh keypair to get a valid seed
        key = nacl.signing.SigningKey.generate()
        seed_hex = bytes_to_hex(bytes(key))

        # Rebuild from hex
        rebuilt = build_signing_key(seed_hex)
        assert bytes(rebuilt) == bytes(key)
        assert bytes(rebuilt.verify_key) == bytes(key.verify_key)

    def test_accepts_0x_prefix(self) -> None:
        key = nacl.signing.SigningKey.generate()
        seed_hex = "0x" + bytes_to_hex(bytes(key))
        rebuilt = build_signing_key(seed_hex)
        assert bytes(rebuilt.verify_key) == bytes(key.verify_key)

    def test_deterministic(self) -> None:
        """Same seed always produces the same public key."""
        seed_hex = "a" * 64  # 32 bytes of 0xaa...
        key1 = build_signing_key(seed_hex)
        key2 = build_signing_key(seed_hex)
        assert bytes(key1.verify_key) == bytes(key2.verify_key)


class TestSignMessage:
    """Tests for sign_message."""

    def test_produces_verifiable_signature(self) -> None:
        key = nacl.signing.SigningKey.generate()
        seed_hex = bytes_to_hex(bytes(key))
        signing_key = build_signing_key(seed_hex)

        message = "1700000000.POST./api/remember.abc123def456"
        sig_hex, pub_hex = sign_message(message, signing_key)

        # Verify the signature
        verify_key = nacl.signing.VerifyKey(hex_to_bytes(pub_hex))
        # This will raise nacl.exceptions.BadSignatureError if invalid
        verify_key.verify(message.encode("utf-8"), hex_to_bytes(sig_hex))

    def test_returns_correct_public_key(self) -> None:
        key = nacl.signing.SigningKey.generate()
        seed_hex = bytes_to_hex(bytes(key))
        signing_key = build_signing_key(seed_hex)

        _, pub_hex = sign_message("test", signing_key)
        assert pub_hex == bytes_to_hex(bytes(key.verify_key))

    def test_signature_is_64_bytes(self) -> None:
        key = nacl.signing.SigningKey.generate()
        signing_key = build_signing_key(bytes_to_hex(bytes(key)))

        sig_hex, _ = sign_message("test message", signing_key)
        # Ed25519 signature is 64 bytes = 128 hex chars
        assert len(sig_hex) == 128

    def test_different_messages_different_signatures(self) -> None:
        key = nacl.signing.SigningKey.generate()
        signing_key = build_signing_key(bytes_to_hex(bytes(key)))

        sig1, _ = sign_message("message one", signing_key)
        sig2, _ = sign_message("message two", signing_key)
        assert sig1 != sig2


class TestBuildSignatureMessage:
    """Tests for build_signature_message -- the exact format the server expects."""

    def test_format_matches_spec(self) -> None:
        """Signature message MUST be: {timestamp}.{method}.{path}.{body_sha256}"""
        result = build_signature_message(
            timestamp="1700000000",
            method="POST",
            path="/api/remember",
            body_sha256="abc123",
        )
        assert result == "1700000000.POST./api/remember.abc123"

    def test_get_method(self) -> None:
        result = build_signature_message(
            timestamp="1700000001",
            method="GET",
            path="/health",
            body_sha256="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        )
        parts = result.split(".")
        assert parts[0] == "1700000001"
        assert parts[1] == "GET"
        # Path contains a dot-free segment
        assert "/health" in result

    def test_full_signing_flow(self) -> None:
        """End-to-end: build message, sign it, verify it."""
        key = nacl.signing.SigningKey.generate()
        signing_key = build_signing_key(bytes_to_hex(bytes(key)))

        # Simulate what the client does
        timestamp = "1700000000"
        method = "POST"
        path = "/api/remember"
        body = json.dumps({"text": "hello", "namespace": "default"}, separators=(",", ":"))
        body_hash = sha256_hex(body)

        message = build_signature_message(timestamp, method, path, body_hash)
        sig_hex, pub_hex = sign_message(message, signing_key)

        # Verify (as the server would)
        verify_key = nacl.signing.VerifyKey(hex_to_bytes(pub_hex))
        verify_key.verify(message.encode("utf-8"), hex_to_bytes(sig_hex))

    def test_body_sha256_matches_json(self) -> None:
        """Ensure the SHA-256 used in the message matches the actual body hash."""
        body = {"text": "test", "namespace": "default"}
        body_str = json.dumps(body, separators=(",", ":"))
        body_hash = sha256_hex(body_str)

        message = build_signature_message("1700000000", "POST", "/api/remember", body_hash)

        # Extract the hash from the message
        extracted_hash = message.split(".")[-1]
        assert extracted_hash == body_hash
        assert extracted_hash == hashlib.sha256(body_str.encode("utf-8")).hexdigest()


class TestDelegateKeyUtils:
    """Tests for delegate_key_to_sui_address and delegate_key_to_public_key."""

    # Known test key used throughout this session
    _KEY = "944aa24c09d8b6d6cc6a8fbedc6dc0942a46e49db7d36596e1b6af6061ec9261"
    _EXPECTED_PUB = "d5b76c57ad1b78438ab9df984b65aa6e2692045a9f3ba642773edd46f3b987b9"

    def test_public_key_matches_known(self):
        from memwal.utils import delegate_key_to_public_key
        pub = delegate_key_to_public_key(self._KEY)
        assert pub.hex() == self._EXPECTED_PUB

    def test_public_key_accepts_0x_prefix(self):
        from memwal.utils import delegate_key_to_public_key
        pub = delegate_key_to_public_key("0x" + self._KEY)
        assert pub.hex() == self._EXPECTED_PUB

    def test_sui_address_is_0x_prefixed(self):
        from memwal.utils import delegate_key_to_sui_address
        addr = delegate_key_to_sui_address(self._KEY)
        assert addr.startswith("0x")

    def test_sui_address_is_32_bytes(self):
        from memwal.utils import delegate_key_to_sui_address
        addr = delegate_key_to_sui_address(self._KEY)
        # "0x" + 64 hex chars = 32 bytes
        assert len(addr) == 66

    def test_sui_address_is_deterministic(self):
        from memwal.utils import delegate_key_to_sui_address
        addr1 = delegate_key_to_sui_address(self._KEY)
        addr2 = delegate_key_to_sui_address(self._KEY)
        assert addr1 == addr2

    def test_sui_address_matches_typescript_sdk(self):
        """Verify blake2b-256(0x00 || pubkey) matches TS delegateKeyToSuiAddress output."""
        from memwal.utils import delegate_key_to_public_key, delegate_key_to_sui_address
        import hashlib

        pub = delegate_key_to_public_key(self._KEY)
        scheme_input = bytes([0x00]) + pub
        expected = "0x" + hashlib.blake2b(scheme_input, digest_size=32).hexdigest()
        assert delegate_key_to_sui_address(self._KEY) == expected
