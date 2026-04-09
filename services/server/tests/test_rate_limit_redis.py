#!/usr/bin/env python3
"""
Test: Rate limiter returns 503 when Redis is down.
Run BEFORE this script:
  1. cargo run (server must be running on port 3001)
  2. docker stop memwal-redis

Then run:
  python3 tests/test_rate_limit_redis.py
"""

import json, hashlib, time, urllib.request, urllib.error
from nacl.signing import SigningKey
from nacl.encoding import RawEncoder

BASE_URL = "http://localhost:3001"

def signed_request(method, path, body, key):
    body_json = json.dumps(body).encode()
    body_hash = hashlib.sha256(body_json).hexdigest()
    timestamp = str(int(time.time()))
    message = f"{timestamp}.{method}.{path}.{body_hash}"
    signed = key.sign(message.encode(), encoder=RawEncoder)
    pub = key.verify_key.encode().hex()
    sig = signed.signature.hex()
    req = urllib.request.Request(
        f"{BASE_URL}{path}", data=body_json,
        headers={
            "Content-Type": "application/json",
            "x-public-key": pub,
            "x-signature": sig,
            "x-timestamp": timestamp,
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

key = SigningKey.generate()
body = {"text": "test memory for rate limit check"}

print("Sending signed POST /api/remember ...")
status, resp = signed_request("POST", "/api/remember", body, key)
print(f"→ HTTP {status}: {resp}")

if status == 503:
    print("\n[PASS] Rate limiter returned 503 — Redis is down, fail-closed working correctly.")
elif status == 200:
    print("\n[INFO] Got 200 — Redis is still UP. Stop it first: docker stop memwal-redis")
else:
    print(f"\n[INFO] Got {status} — {resp}")
