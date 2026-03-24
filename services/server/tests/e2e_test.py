#!/usr/bin/env python3
"""
E2E test for memwal Server — Full Ed25519 keypair flow.

Tests:
1. Generate Ed25519 keypair
2. Sign request → POST /api/remember (store vector)
3. Sign request → POST /api/recall (search similar vectors)
4. Sign request → POST /api/embed (stub)
5. Verify unauthorized requests are rejected
"""

import json
import hashlib
import time
import urllib.request
import urllib.error

from nacl.signing import SigningKey
from nacl.encoding import RawEncoder

BASE_URL = "http://localhost:3001"

def make_signed_request(method: str, path: str, body: dict, signing_key: SigningKey) -> dict:
    """Make a signed HTTP request to the server."""
    # Prepare body
    body_json = json.dumps(body).encode()
    body_hash = hashlib.sha256(body_json).hexdigest()
    
    # Timestamp
    timestamp = str(int(time.time()))
    
    # Build message to sign: "{timestamp}.{method}.{path}.{body_sha256}"
    message = f"{timestamp}.{method}.{path}.{body_hash}"
    
    # Sign with Ed25519
    signed = signing_key.sign(message.encode(), encoder=RawEncoder)
    signature = signed.signature  # 64 bytes
    
    # Get public key (32 bytes)
    verify_key = signing_key.verify_key
    public_key_hex = verify_key.encode().hex()
    signature_hex = signature.hex()
    
    # Build request
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(
        url,
        data=body_json,
        headers={
            "Content-Type": "application/json",
            "x-public-key": public_key_hex,
            "x-signature": signature_hex,
            "x-timestamp": timestamp,
        },
        method=method,
    )
    
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def test_health():
    """Test health endpoint (no auth required)."""
    req = urllib.request.Request(f"{BASE_URL}/health")
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
        assert data["status"] == "ok", f"Expected ok, got {data['status']}"
        print(f"[pass] health check: {data}")


def test_unauthorized():
    """Test that endpoints reject unsigned requests."""
    body = json.dumps({"blob_id": "test", "vector": [0.1], "owner": "0x123"}).encode()
    req = urllib.request.Request(
        f"{BASE_URL}/api/remember",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req)
        assert False, "Should have returned 401"
    except urllib.error.HTTPError as e:
        assert e.code == 401, f"Expected 401, got {e.code}"
        print(f"[pass] unsigned request rejected: {e.code}")


def test_remember_recall_flow(signing_key: SigningKey):
    """Test remember → recall full flow with signed requests."""
    pk_hex = signing_key.verify_key.encode().hex()
    
    # Generate a test vector (small for testing)
    test_vector = [0.1 * i for i in range(10)]

    # 1. Remember (store a memory)
    remember_body = {
        "blob_id": "blob_test_001",
        "vector": test_vector,
        "owner": pk_hex,
    }
    result = make_signed_request("POST", "/api/remember", remember_body, signing_key)
    assert "id" in result, f"Expected 'id' in response, got {result}"
    assert result["blob_id"] == "blob_test_001"
    assert result["owner"] == pk_hex
    print(f"[pass] remember: id={result['id']}, blob_id={result['blob_id']}")

    # 2. Store another memory with different vector
    test_vector_2 = [0.2 * i for i in range(10)]
    remember_body_2 = {
        "blob_id": "blob_test_002",
        "vector": test_vector_2,
        "owner": pk_hex,
    }
    result2 = make_signed_request("POST", "/api/remember", remember_body_2, signing_key)
    print(f"[pass] remember #2: id={result2['id']}, blob_id={result2['blob_id']}")

    # 3. Recall (search for similar vectors)
    recall_body = {
        "vector": test_vector,  # Search with same vector as first memory
        "owner": pk_hex,
        "limit": 5,
    }
    recall_result = make_signed_request("POST", "/api/recall", recall_body, signing_key)
    assert "results" in recall_result
    assert recall_result["total"] >= 1, f"Expected at least 1 result, got {recall_result['total']}"
    
    # First result should be the exact match (distance ≈ 0)
    top_hit = recall_result["results"][0]
    assert top_hit["blob_id"] == "blob_test_001", f"Expected blob_test_001, got {top_hit['blob_id']}"
    assert top_hit["distance"] < 0.01, f"Expected near-zero distance, got {top_hit['distance']}"
    print(f"[pass] recall: {recall_result['total']} results, top hit = {top_hit['blob_id']} (dist={top_hit['distance']:.6f})")


def test_embed_stub(signing_key: SigningKey):
    """Test embed endpoint (stub returns mock vector)."""
    embed_body = {"text": "Hello, this is a test memory about AI and coding."}
    result = make_signed_request("POST", "/api/embed", embed_body, signing_key)
    assert "vector" in result
    assert len(result["vector"]) == 1536, f"Expected 1536 dims, got {len(result['vector'])}"
    print(f"[pass] embed stub: returned {len(result['vector'])} dimensions")


def test_wrong_signature():
    """Test that a valid format but wrong signature is rejected."""
    # Generate two different keys
    key_a = SigningKey.generate()
    key_b = SigningKey.generate()
    
    body = {"blob_id": "evil", "vector": [0.1], "owner": "evil"}
    body_json = json.dumps(body).encode()
    body_hash = hashlib.sha256(body_json).hexdigest()
    timestamp = str(int(time.time()))
    message = f"{timestamp}.POST./api/remember.{body_hash}"
    
    # Sign with key_a but send key_b's public key
    signed = key_a.sign(message.encode(), encoder=RawEncoder)
    
    req = urllib.request.Request(
        f"{BASE_URL}/api/remember",
        data=body_json,
        headers={
            "Content-Type": "application/json",
            "x-public-key": key_b.verify_key.encode().hex(),  # Wrong key!
            "x-signature": signed.signature.hex(),
            "x-timestamp": timestamp,
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req)
        assert False, "Should have returned 401 for wrong signature"
    except urllib.error.HTTPError as e:
        assert e.code == 401
        print(f"[pass] wrong signature rejected: {e.code}")


def test_expired_timestamp(signing_key: SigningKey):
    """Test that expired timestamps are rejected."""
    body = {"blob_id": "old", "vector": [0.1], "owner": "old"}
    body_json = json.dumps(body).encode()
    body_hash = hashlib.sha256(body_json).hexdigest()
    
    # Use timestamp from 10 minutes ago (beyond 5 min window)
    old_timestamp = str(int(time.time()) - 600)
    message = f"{old_timestamp}.POST./api/remember.{body_hash}"
    
    signed = signing_key.sign(message.encode(), encoder=RawEncoder)
    
    req = urllib.request.Request(
        f"{BASE_URL}/api/remember",
        data=body_json,
        headers={
            "Content-Type": "application/json",
            "x-public-key": signing_key.verify_key.encode().hex(),
            "x-signature": signed.signature.hex(),
            "x-timestamp": old_timestamp,
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req)
        assert False, "Should have returned 401 for expired timestamp"
    except urllib.error.HTTPError as e:
        assert e.code == 401
        print(f"[pass] expired timestamp rejected: {e.code}")


if __name__ == "__main__":
    print("=" * 50)
    print("  memwal Server — E2E Test Suite")
    print("=" * 50)
    print()
    
    # Generate a fresh Ed25519 keypair
    signing_key = SigningKey.generate()
    pk_hex = signing_key.verify_key.encode().hex()
    print(f"generated Ed25519 keypair")
    print(f"   Public key: {pk_hex[:16]}...{pk_hex[-16:]}")
    print()
    
    # Run tests
    print("--- Basic Tests ---")
    test_health()
    test_unauthorized()
    print()
    
    print("--- Auth Tests ---")
    test_wrong_signature()
    test_expired_timestamp(signing_key)
    print()
    
    print("--- API Flow Tests ---")
    test_remember_recall_flow(signing_key)
    test_embed_stub(signing_key)
    print()
    
    print("=" * 50)
    print("  all tests passed")
    print("=" * 50)
