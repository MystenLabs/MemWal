# E2E Test Infrastructure for Walrus Memory Rust Relayer

This document describes the design and implementation of the E2E testing infrastructure for the native Rust migration of the Walrus Memory relayer.

## Overview
The E2E test suite uses an **opaque-box** testing model that interacts solely with the HTTP endpoints of the Axum relayer server. It validates all features and cryptographic auth contracts (NaCl signing, nonce verification, timestamp checks) under simulated local network conditions.

## Architecture

```
+--------------------------------------------------------------------+
|                           Test Runner                              |
|                    (services/server/tests/e2e_runner.py)            |
+------------------+-----------------------+-------------------------+
                   |                       |
                   v                       v
+------------------+----+            +-----+-------------------------+
|      Mock Server       |            |        Pytest Suite          |
|  (mock_server.py:8080) |            |   (test_e2e.py against 3001)  |
+------------------+----+            +-----+-------------------------+
                   ^                       |
                   | RPC/API calls         | signed HTTP requests
                   |                       v
             +-----+-----------------------+-------------------------+
             |            Axum Relayer Server (Port 3001)            |
             +-----------------------------+-------------------------+
                                           |
                                           v
                                   [Postgres & Redis]
```

### 1. Mock Server (`services/server/tests/mock_server.py`)
To enable fully offline testing in a restricted network mode, a stateful mock server is implemented in Python using the built-in `http.server`. It mocks:
* **Sui JSON-RPC**: `sui_getObject` for the account registry and individual account queries; `suix_getDynamicFields` for accounts Table scanning. It statefully verifies delegate keys.
* **OpenAI API**: `/v1/embeddings` and `/v1/chat/completions` for fact extraction, summarization, and answering.
* **Walrus sidecar/aggregator**: `/walrus/upload`, `POST /walrus/query-blobs`, and `/v1/blobs/{blob_id}` for stateful blob persistence and cold reads.
* **SEAL key servers/decryption**: `/seal/encrypt`, `/seal/decrypt`, and `/seal/decrypt-batch` for stateful threshold encryption.
* **Sponsorship proxy**: `/sponsor` and `/sponsor/execute` for transaction gas sponsorship.

### 2. Pytest Suite (`services/server/tests/test_e2e.py`)
A comprehensive pytest suite covering 10 features with a 4-tier test case design, containing **115 test cases** total.

* **Tier 1: Feature Coverage (50 test cases, 5 per feature)**
  Validates happy paths for all 10 features in isolation:
  1. Health & Version API
  2. Configuration API
  3. Remember Ingestion
  4. Bulk Remember Ingestion
  5. Manual Remember Ingestion
  6. Recall & Composite Ranking
  7. Ask (AI Answering)
  8. Admin (Forget & Stats)
  9. Restore
  10. Sponsor proxy

* **Tier 2: Boundary & Corner Cases (50 test cases, 5 per feature)**
  Validates negative paths, invalid payloads, empty parameters, overflow bodies, expired/future signatures, replay attacks, and rate limits.

* **Tier 3: Cross-Feature Combinations (10 test cases)**
  Validates state transition sequences and pairwise feature interactions, such as:
  * Ingesting standard memory -> querying recall on same namespace.
  * Ingesting manual memory -> verifying stats increment -> forget -> stats reset.
  * Bulk ingestion -> recall.
  * Ingesting -> ask integration.
  * Ingesting -> forget -> restore -> recall.
  * Namespace isolation verification.
  * Key deactivation on-chain and failure path check.

* **Tier 4: Real-World Application Scenarios (5 test cases)**
  Simulates realistic workflow patterns:
  1. Interactive AI Assistant context loop.
  2. Multi-user shared environment privacy checks.
  3. Bulk note importing and keyword search.
  4. Disaster recovery and restore simulation.
  5. Sponsored gas transaction remember flow.

## Running the E2E Test Suite

### Prerequisites
* Docker and Docker Compose
* Python 3.9+ with `pynacl` and `requests`

### Run Command
To start the docker containers, compilation, mock server, and pytest suite, execute:
```bash
python3 services/server/tests/e2e_runner.py
```
