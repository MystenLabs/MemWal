#!/usr/bin/env python3
"""
Test: Verify /api/analyze double-charge bug.

Expected (bug present):  first call returns 429 immediately, before LLM runs
Expected (bug fixed):    first call returns 200 or valid LLM error

Run:
  python3 tests/test_analyze_rate_limit.py
"""

import json, hashlib, time, urllib.request, urllib.error, os, sys
from nacl.signing import SigningKey
from nacl.encoding import RawEncoder
import redis

BASE_URL = "http://localhost:3001"
PRIVATE_KEY_HEX = os.environ.get("TEST_DELEGATE_KEY")
ACCOUNT_ID      = os.environ.get("TEST_ACCOUNT_ID")

if not PRIVATE_KEY_HEX or not ACCOUNT_ID:
    print("Usage: TEST_DELEGATE_KEY=<hex> TEST_ACCOUNT_ID=<0x...> python3 tests/test_analyze_rate_limit.py")
    sys.exit(1)

def signed_request(method, path, body):
    key       = SigningKey(bytes.fromhex(PRIVATE_KEY_HEX))
    body_json = json.dumps(body).encode()
    body_hash = hashlib.sha256(body_json).hexdigest()
    timestamp = str(int(time.time()))
    message   = f"{timestamp}.{method}.{path}.{body_hash}"
    signed    = key.sign(message.encode(), encoder=RawEncoder)
    pub       = key.verify_key.encode().hex()
    sig       = signed.signature.hex()

    req = urllib.request.Request(
        f"{BASE_URL}{path}", data=body_json,
        headers={
            "Content-Type":  "application/json",
            "x-public-key":  pub,
            "x-signature":   sig,
            "x-timestamp":   timestamp,
            "x-account-id":  ACCOUNT_ID,
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            body = json.loads(raw) if raw else {}
        except Exception:
            body = {"raw": raw.decode(errors="replace")}
        return e.code, body

def flush_rate_limit_keys():
    """Clear Redis rate limit keys for this delegate key so each test starts fresh."""
    key       = SigningKey(bytes.fromhex(PRIVATE_KEY_HEX))
    pub       = key.verify_key.encode().hex()
    r         = redis.Redis(host="localhost", port=6379, decode_responses=True)
    dk_key    = f"rate:dk:{pub}"
    burst_key = f"rate:{ACCOUNT_ID}"
    hourly    = f"rate:hr:{ACCOUNT_ID}"
    for k in [dk_key, burst_key, hourly]:
        deleted = r.delete(k)
        print(f"  flushed {k} ({deleted} key deleted)")

# ─────────────────────────────────────────────
print("=" * 60)
print("TEST: /api/analyze double-charge bug")
print("=" * 60)
print()

# Step 1: flush any leftover rate limit state
print("[setup] Flushing Redis rate limit keys...")
flush_rate_limit_keys()
print()

# Step 2: send ONE /api/analyze call (bình đang trống = 0/30)
print("[test] Sending first /api/analyze call (fresh rate limit window)...")
status, resp = signed_request("POST", "/api/analyze", {
    "text": "My name is Harry. I live in Hanoi. I like coffee.",
    "namespace": "default"
})
print(f"  → HTTP {status}")
print(f"  → Response: {json.dumps(resp, indent=2)}")
print()

# Step 3: verdict
print("─" * 60)
if status == 429:
    print("[FAIL] BUG CONFIRMED — got 429 on first call with empty rate limit window.")
    print("       Cause: middleware charged 10 + handler pre-charged 30 = 40 > limit 30.")
    print("       Fix needed: move charge_explicit_weight to AFTER extract_facts_llm.")
elif status == 200:
    print("[PASS] No bug — first call succeeded.")
elif status == 401:
    print("[SKIP] Auth failed — delegate key not registered on-chain or expired.")
elif status == 500:
    print(f"[INFO] Server error (likely missing OPENAI_API_KEY) — but NOT 429, so rate limit is OK.")
    print(f"       Response: {resp}")
else:
    print(f"[INFO] HTTP {status} — {resp}")
