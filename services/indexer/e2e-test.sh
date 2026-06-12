#!/bin/bash
# MemWal Indexer End-to-End Test
# Usage: ./e2e-test.sh [duration_seconds]
#
# This script:
# 1. Spins up a temporary PostgreSQL container
# 2. Builds the indexer in release mode
# 3. Runs it against Sui testnet for N seconds
# 4. Verifies DB state
# 5. Tests graceful shutdown
# 6. Cleans up

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DURATION="${1:-30}"
POSTGRES_CONTAINER="memwal-indexer-e2e-postgres"
LOGFILE="/tmp/memwal-indexer-e2e.log"

# Package ID used for testing — this is a dummy package on testnet.
# Replace with a real MemWal package ID to test actual event ingestion.
TEST_PACKAGE_ID="0x0000000000000000000000000000000000000000000000000000000000000001"

cleanup() {
    echo "Cleaning up..."
    if docker ps -q -f name="$POSTGRES_CONTAINER" | grep -q .; then
        docker stop "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
        docker rm "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
    fi
    rm -f "$LOGFILE"
}
trap cleanup EXIT

echo "=== MemWal Indexer E2E Test ==="
echo "Duration: ${DURATION}s"
echo ""

# Step 1: Start PostgreSQL
echo "[1/5] Starting PostgreSQL container..."
docker run -d \
    --name "$POSTGRES_CONTAINER" \
    -e POSTGRES_USER=memwal \
    -e POSTGRES_PASSWORD=memwal \
    -e POSTGRES_DB=memwal \
    -p 15432:5432 \
    postgres:16-alpine \
    -c 'max_connections=10' >/dev/null

for i in {1..30}; do
    if docker exec "$POSTGRES_CONTAINER" pg_isready -U memwal -d memwal >/dev/null 2>&1; then
        echo "      PostgreSQL ready"
        break
    fi
    sleep 1
done

# Step 2: Build
echo "[2/5] Building indexer..."
cargo build --release --quiet

# Step 3: Run indexer
echo "[3/5] Running indexer against testnet for ${DURATION}s..."
export DATABASE_URL="postgres://memwal:memwal@localhost:15432/memwal"
export SUI_RPC_URL="https://fullnode.testnet.sui.io:443"
export MEMWAL_PACKAGE_ID="$TEST_PACKAGE_ID"
export POLL_INTERVAL_SECS="3"
export RUST_LOG="memwal_indexer=info"

./target/release/memwal-indexer > "$LOGFILE" 2>&1 &
PID=$!

sleep "$DURATION"

# Step 4: Graceful shutdown
echo "[4/5] Sending graceful shutdown signal..."
kill -INT "$PID" 2>/dev/null || true

for i in {1..10}; do
    if ! kill -0 "$PID" 2>/dev/null; then
        break
    fi
    sleep 1
done

if kill -0 "$PID" 2>/dev/null; then
    echo "      Force killing..."
    kill -9 "$PID" 2>/dev/null || true
fi

# Step 5: Verify DB state
echo "[5/5] Verifying database state..."

TABLES=$(docker exec "$POSTGRES_CONTAINER" psql -U memwal -d memwal -Atc "
    SELECT tablename FROM pg_tables WHERE schemaname = 'public';
")

if echo "$TABLES" | grep -q "^accounts$"; then
    echo "      ✅ accounts table exists"
else
    echo "      ❌ accounts table missing"
    exit 1
fi

if echo "$TABLES" | grep -q "^indexer_state$"; then
    echo "      ✅ indexer_state table exists"
else
    echo "      ❌ indexer_state table missing"
    exit 1
fi

echo ""
echo "=== Log Output ==="
cat "$LOGFILE"
echo ""
echo "=== E2E Test Passed ==="
