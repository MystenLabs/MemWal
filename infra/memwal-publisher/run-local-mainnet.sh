#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER_ENV="$ROOT_DIR/services/server/.env"
PUBLISHER_ENV="$ROOT_DIR/services/server/.env.walrus-publisher"
WALLETS_DIR="${MEMWAL_PUBLISHER_WALLETS_DIR:-$ROOT_DIR/infra/memwal-publisher/wallets}"
IMAGE="${MEMWAL_PUBLISHER_IMAGE:-memwal-publisher:local}"
BASE_IMAGE="cmdoss/walrus:${WALRUS_PUBLISHER_IMAGE_TAG:-v0.1.1}"

if [[ ! -f "$SERVER_ENV" ]]; then
  echo "Missing $SERVER_ENV" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$SERVER_ENV"
if [[ -f "$PUBLISHER_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$PUBLISHER_ENV"
fi
set +a

PUBLISHER_KEY_INPUT="${PUBLISHER_SUI_KEYSTORE_BASE64:-${PUBLISHER_SUI_PRIVATE_KEY:-${SERVER_SUI_PRIVATE_KEY:-}}}"
if [[ -z "$PUBLISHER_KEY_INPUT" ]]; then
  echo "Set PUBLISHER_SUI_KEYSTORE_BASE64, PUBLISHER_SUI_PRIVATE_KEY, or SERVER_SUI_PRIVATE_KEY before starting the publisher." >&2
  exit 1
fi

if [[ -z "${WALRUS_PUBLISHER_JWT_SECRET:-}" ]]; then
  echo "Set WALRUS_PUBLISHER_JWT_SECRET before starting the publisher." >&2
  exit 1
fi

mkdir -p "$WALLETS_DIR"

PUBLISHER_KEYSTORE="$PUBLISHER_KEY_INPUT"
if [[ "$PUBLISHER_KEY_INPUT" == suiprivkey1* ]]; then
  TMP_KEYSTORE_DIR="$(mktemp -d)"
  cleanup() {
    rm -rf "$TMP_KEYSTORE_DIR"
  }
  trap cleanup EXIT
  PUBLISHER_KEYSTORE=""
  for scheme in ed25519 secp256k1 secp256r1; do
    rm -f "$TMP_KEYSTORE_DIR/sui.keystore"
    if docker run --rm \
      -e SUI_IMPORT_KEY="$PUBLISHER_KEY_INPUT" \
      -v "$TMP_KEYSTORE_DIR:/tmp/sui" \
      --entrypoint sh "$BASE_IMAGE" \
      -lc "sui keytool --keystore-path /tmp/sui/sui.keystore import \"\$SUI_IMPORT_KEY\" $scheme --alias publisher -q >/dev/null 2>&1"; then
      PUBLISHER_KEYSTORE="$(tr -d '[]",[:space:]' < "$TMP_KEYSTORE_DIR/sui.keystore")"
      break
    fi
  done
  if [[ -z "$PUBLISHER_KEYSTORE" ]]; then
    echo "Failed to convert suiprivkey publisher key to Sui keystore format." >&2
    exit 1
  fi
fi

docker build -t "$IMAGE" "$ROOT_DIR/infra/memwal-publisher"

docker rm -f memwal-walrus-publisher memwal-publisher >/dev/null 2>&1 || true
docker run -d --name memwal-publisher \
  -p 127.0.0.1:${MEMWAL_PUBLISHER_PORT:-31416}:31416 \
  -p 127.0.0.1:${WALRUS_PUBLISHER_METRICS_PORT:-27182}:27182 \
  -e NETWORK=mainnet \
  -e SUI_KEYSTORE="$PUBLISHER_KEYSTORE" \
  -e JWT_DECODE_SECRET="$WALRUS_PUBLISHER_JWT_SECRET" \
  -e MEMWAL_PUBLISHER_JWT_SECRET="$WALRUS_PUBLISHER_JWT_SECRET" \
  -e MEMWAL_PUBLISHER_BIND_ADDRESS=0.0.0.0:31416 \
  -e STOCK_PUBLISHER_BIND_ADDRESS=127.0.0.1:31415 \
  -e N_CLIENTS="${WALRUS_PUBLISHER_N_CLIENTS:-4}" \
  -e PUBLISHER_MAX_CONCURRENT_REQUESTS="${WALRUS_PUBLISHER_MAX_CONCURRENT_REQUESTS:-4}" \
  -e PUBLISHER_MAX_BUFFER_SIZE="${WALRUS_PUBLISHER_MAX_BUFFER_SIZE:-8}" \
  -e MAX_BODY_SIZE="${WALRUS_PUBLISHER_MAX_BODY_SIZE_KB:-10240}" \
  -e MEMWAL_PUBLISHER_METADATA_RETRY_DELAYS_MS="${MEMWAL_PUBLISHER_METADATA_RETRY_DELAYS_MS:-1000,2000,5000}" \
  -v "$WALLETS_DIR:/wallets" \
  "$IMAGE"

echo "MemWal publisher started on http://127.0.0.1:${MEMWAL_PUBLISHER_PORT:-31416}"
