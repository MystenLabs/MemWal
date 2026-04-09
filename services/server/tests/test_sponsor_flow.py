#!/usr/bin/env python3
"""
Test: Sponsor endpoint auth flow after HIGH-4 fix + SetupWizard regression fix.

Prerequisites:
  1. cargo run (server on port 3001, sidecar on port 9000)
  2. SIDECAR_AUTH_TOKEN set in services/server/.env

What this proves:
  - Unauthenticated /sponsor → 401 (HIGH-4 security preserved)
  - Random key (not on-chain) → auth PASSES (SetupWizard flow fixed)
  - Registered key (on-chain) → auth PASSES (Dashboard flow unchanged)
  - Rate limit is per-key, not shared across all sponsor requests (rate limit bucket fix)
    Without fix: all unregistered keys share "rate:" → 1 attacker blocks all SetupWizard users
    With fix:    each key gets "rate:<pubkey>" → independent buckets

Run:
  python3 tests/test_sponsor_flow.py

  # With real registered key (optional):
  TEST_DELEGATE_KEY=<hex> TEST_ACCOUNT_ID=<0x...> python3 tests/test_sponsor_flow.py
"""

import hashlib, json, os, sys, time, urllib.error, urllib.request
from nacl.encoding import RawEncoder
from nacl.signing import SigningKey

BASE = "http://localhost:3001"
PASS = "[PASS]"
FAIL = "[FAIL]"
SKIP = "[SKIP]"


def raw_post(url, body=None, headers=None):
    data = json.dumps(body or {}).encode()
    h = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw.decode(errors="replace")}


def signed_post(path, body, key, account_id=None):
    body_json = json.dumps(body).encode()
    body_hash = hashlib.sha256(body_json).hexdigest()
    ts = str(int(time.time()))
    msg = f"{ts}.POST.{path}.{body_hash}"
    signed = key.sign(msg.encode(), encoder=RawEncoder)
    headers = {
        "Content-Type": "application/json",
        "x-public-key": key.verify_key.encode().hex(),
        "x-signature": signed.signature.hex(),
        "x-timestamp": ts,
    }
    if account_id:
        headers["x-account-id"] = account_id
    req = urllib.request.Request(f"{BASE}{path}", data=body_json, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw.decode(errors="replace")}


print("=" * 60)
print("Sponsor Auth Flow Tests")
print("=" * 60)

results = {}

# ── Test 1: No auth → must 401 ─────────────────────────────────
print("\n[1] Unauthenticated /sponsor → must 401 (HIGH-4 preserved)")
status, resp = raw_post(f"{BASE}/sponsor", {"transactionBlockKindBytes": "abc", "sender": "0x1"})
if status == 401:
    print(f"  {PASS} /sponsor (no auth) → {status}")
    results["no-auth /sponsor"] = True
else:
    print(f"  {FAIL} /sponsor (no auth) → {status} {resp}")
    results["no-auth /sponsor"] = False

status, resp = raw_post(f"{BASE}/sponsor/execute", {"digest": "abc", "signature": "sig"})
if status == 401:
    print(f"  {PASS} /sponsor/execute (no auth) → {status}")
    results["no-auth /sponsor/execute"] = True
else:
    print(f"  {FAIL} /sponsor/execute (no auth) → {status} {resp}")
    results["no-auth /sponsor/execute"] = False


# ── Test 2: Random key (not on-chain) → auth must PASS ─────────
print("\n[2] Random key (not on-chain) → auth must pass (SetupWizard flow)")
random_key = SigningKey.generate()
status, resp = signed_post("/sponsor", {"transactionBlockKindBytes": "abc", "sender": "0x1"}, random_key)
if status != 401:
    print(f"  {PASS} /sponsor (random key) → {status} — auth passed, key not required on-chain")
    results["random-key /sponsor"] = True
else:
    print(f"  {FAIL} /sponsor (random key) → 401 — auth still blocking (fix not working)")
    results["random-key /sponsor"] = False


# ── Test 3: Registered key (on-chain) → auth must PASS ─────────
print("\n[3] Registered key (on-chain) → auth must pass (Dashboard flow)")
registered_key_hex = os.environ.get("TEST_DELEGATE_KEY")
account_id = os.environ.get("TEST_ACCOUNT_ID")

if registered_key_hex and account_id:
    reg_key = SigningKey(bytes.fromhex(registered_key_hex))
    status, resp = signed_post("/sponsor", {"transactionBlockKindBytes": "abc", "sender": "0x1"}, reg_key, account_id)
    if status != 401:
        print(f"  {PASS} /sponsor (registered key) → {status}")
        results["registered-key /sponsor"] = True
    else:
        print(f"  {FAIL} /sponsor (registered key) → 401 {resp}")
        results["registered-key /sponsor"] = False
else:
    print(f"  {SKIP} set TEST_DELEGATE_KEY and TEST_ACCOUNT_ID to test with real key")
    results["registered-key /sponsor"] = None


# ── Test 4: Rate limit buckets are per-key, not shared ─────────
# /sponsor weight=5, per-delegate-key limit=30 → triggers at request #7
# Without the owner fix: all keys collapse to "rate:" (shared bucket)
# With the fix:          each key gets "rate:<pubkey>" (independent)
#
# To run this test Redis must be reachable and keys must be fresh
# (guaranteed since we generate new random keys each run).
print("\n[4] Rate limit: per-key isolation (not shared global bucket)")
key_a = SigningKey.generate()
key_b = SigningKey.generate()
sponsor_body = {"transactionBlockKindBytes": "abc", "sender": "0x1"}

# Exhaust key_a's per-key quota
# weight=5, per-key limit=30 → limit hit on request 7 (7×5=35 > 30)
hit_limit_at = None
for i in range(8):
    status, resp = signed_post("/sponsor", sponsor_body, key_a)
    if status == 429:
        hit_limit_at = i + 1
        break

if hit_limit_at is None:
    print(f"  {FAIL} key_a never hit 429 after 8 requests — rate limit not enforced")
    results["rate-limit enforcement"] = False
    results["rate-limit per-key isolation"] = False
else:
    print(f"  {PASS} key_a hit 429 at request #{hit_limit_at} (rate limit enforced)")
    results["rate-limit enforcement"] = True

    # key_b is a fresh key — must NOT be affected by key_a's exhausted bucket
    # If buckets are shared (bug): key_b → 429
    # If buckets are per-key (fix): key_b → not 429
    status_b, resp_b = signed_post("/sponsor", sponsor_body, key_b)
    if status_b != 429:
        print(f"  {PASS} key_b unaffected by key_a's limit → {status_b} (buckets are independent)")
        results["rate-limit per-key isolation"] = True
    else:
        print(f"  {FAIL} key_b got 429 — rate limits are shared (fix: set owner=public_key in verify_signature_sponsor)")
        results["rate-limit per-key isolation"] = False


# ── Summary ────────────────────────────────────────────────────
print("\n" + "=" * 60)
passed = sum(1 for v in results.values() if v is True)
failed = sum(1 for v in results.values() if v is False)
skipped = sum(1 for v in results.values() if v is None)
for name, result in results.items():
    mark = PASS if result is True else FAIL if result is False else SKIP
    print(f"  {mark} {name}")
print(f"\n{passed} passed, {failed} failed, {skipped} skipped")
if failed:
    sys.exit(1)
