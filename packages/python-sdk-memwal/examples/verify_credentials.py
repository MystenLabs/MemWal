"""Verify MemWal example credentials before calling the relayer.

Usage:
    MEMWAL_PRIVATE_KEY=<hex> MEMWAL_ACCOUNT_ID=0x... python examples/verify_credentials.py

Optional:
    Set MEMWAL_DELEGATE_PUBLIC_KEY to the dashboard public key to fail on
    public/private key mismatch.
"""

from __future__ import annotations

import os
import re
import sys

import nacl.signing

HEX_32_BYTES = re.compile(r"^(0x)?[0-9a-fA-F]{64}$")
ACCOUNT_ID = re.compile(r"^0x[0-9a-fA-F]{64}$")


def normalize_hex(value: str) -> str:
    value = value.strip()
    return value[2:] if value.lower().startswith("0x") else value


def main() -> None:
    private_key = os.environ.get("MEMWAL_PRIVATE_KEY") or ""
    account_id = os.environ.get("MEMWAL_ACCOUNT_ID") or ""
    expected_public_key = os.environ.get("MEMWAL_DELEGATE_PUBLIC_KEY") or ""
    server_url = os.environ.get("MEMWAL_SERVER_URL") or ""

    if not private_key:
        raise SystemExit("MEMWAL_PRIVATE_KEY is required")
    if not HEX_32_BYTES.match(private_key):
        raise SystemExit("MEMWAL_PRIVATE_KEY must be a 64-character Ed25519 private key hex string")
    if account_id and not ACCOUNT_ID.match(account_id):
        raise SystemExit("MEMWAL_ACCOUNT_ID must be a 0x-prefixed 32-byte Sui object ID")

    signing_key = nacl.signing.SigningKey(bytes.fromhex(normalize_hex(private_key)))
    derived_public_key = signing_key.verify_key.encode().hex()

    if expected_public_key and derived_public_key != normalize_hex(expected_public_key).lower():
        raise SystemExit(
            "MEMWAL_PRIVATE_KEY does not derive MEMWAL_DELEGATE_PUBLIC_KEY. "
            "You may have pasted a public key or a key from another account."
        )

    print("MemWal credentials look parseable.")
    print(f"Derived delegate public key: {derived_public_key}")
    if account_id:
        print(f"Account ID: {account_id}")
    if server_url:
        print(f"Relayer URL: {server_url}")
    if not expected_public_key:
        print("Set MEMWAL_DELEGATE_PUBLIC_KEY to fail on public/private key mismatch.")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1) from exc
