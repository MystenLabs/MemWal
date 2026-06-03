#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[memwal-publisher] $*"
}

NETWORK="${NETWORK:-${SUI_NETWORK:-mainnet}}"
if [[ "$NETWORK" != "mainnet" && "$NETWORK" != "testnet" ]]; then
  echo "NETWORK must be mainnet or testnet" >&2
  exit 1
fi

JWT_SECRET="${MEMWAL_PUBLISHER_JWT_SECRET:-${JWT_DECODE_SECRET:-${WALRUS_PUBLISHER_JWT_SECRET:-}}}"
if [[ -z "$JWT_SECRET" ]]; then
  echo "MEMWAL_PUBLISHER_JWT_SECRET, JWT_DECODE_SECRET, or WALRUS_PUBLISHER_JWT_SECRET is required" >&2
  exit 1
fi

KEY_INPUT="${SUI_KEYSTORE:-${PUBLISHER_SUI_KEYSTORE_BASE64:-${PUBLISHER_SUI_PRIVATE_KEY:-${SERVER_SUI_PRIVATE_KEY:-}}}}"
if [[ -z "$KEY_INPUT" ]]; then
  echo "SUI_KEYSTORE, PUBLISHER_SUI_KEYSTORE_BASE64, PUBLISHER_SUI_PRIVATE_KEY, or SERVER_SUI_PRIVATE_KEY is required" >&2
  exit 1
fi

mkdir -p /config /wallets

SUI_KEYSTORE="$KEY_INPUT"
if [[ "$KEY_INPUT" == suiprivkey1* ]]; then
  TMP_KEYSTORE_DIR="$(mktemp -d)"
  SUI_KEYSTORE=""
  for scheme in ed25519 secp256k1 secp256r1; do
    rm -f "$TMP_KEYSTORE_DIR/sui.keystore"
    if sui keytool \
      --keystore-path "$TMP_KEYSTORE_DIR/sui.keystore" \
      import "$KEY_INPUT" "$scheme" \
      --alias publisher \
      -q >/dev/null 2>&1; then
      SUI_KEYSTORE="$(tr -d '[]",[:space:]' < "$TMP_KEYSTORE_DIR/sui.keystore")"
      break
    fi
  done
  rm -rf "$TMP_KEYSTORE_DIR"
  if [[ -z "$SUI_KEYSTORE" ]]; then
    echo "Failed to convert suiprivkey publisher key to Sui keystore format." >&2
    exit 1
  fi
fi
export SUI_KEYSTORE

gomplate --input-dir /templates --output-dir /config

SUB_WALLETS_DIR="${SUB_WALLETS_DIR:-/wallets}"
STOCK_BIND_ADDRESS="${STOCK_PUBLISHER_BIND_ADDRESS:-127.0.0.1:31415}"
METRICS_ADDRESS="${METRICS_ADDRESS:-[::]:27182}"

STOCK_ARGS=(
  publisher
  --bind-address "$STOCK_BIND_ADDRESS"
  --config /config/client-config.yml
  --metrics-address "$METRICS_ADDRESS"
  --wallet /config/wallet-config.yml
  --max-body-size "${MAX_BODY_SIZE:-10240}"
  --max-quilt-body-size "${MAX_QUILT_BODY_SIZE:-102400}"
  --publisher-max-buffer-size "${PUBLISHER_MAX_BUFFER_SIZE:-${WALRUS_PUBLISHER_MAX_BUFFER_SIZE:-8}}"
  --publisher-max-concurrent-requests "${PUBLISHER_MAX_CONCURRENT_REQUESTS:-${WALRUS_PUBLISHER_MAX_CONCURRENT_REQUESTS:-8}}"
  --n-clients "${N_CLIENTS:-${WALRUS_PUBLISHER_N_CLIENTS:-8}}"
  --refill-interval "${REFILL_INTERVAL:-1s}"
  --sub-wallets-dir "$SUB_WALLETS_DIR"
  --gas-refill-amount "${GAS_REFILL_AMOUNT:-500000000}"
  --wal-refill-amount "${WAL_REFILL_AMOUNT:-500000000}"
  --sub-wallets-min-balance "${SUB_WALLETS_MIN_BALANCE:-500000000}"
)

if [[ "${BURN_AFTER_STORE:-0}" == "1" ]]; then
  STOCK_ARGS+=(--burn-after-store)
fi

log "starting internal stock Walrus publisher on $STOCK_BIND_ADDRESS"
walrus "${STOCK_ARGS[@]}" &
stock_pid=$!

cleanup() {
  kill "$stock_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for i in $(seq 1 120); do
  if curl -fsS "http://${STOCK_BIND_ADDRESS}/v1/api" >/dev/null 2>&1; then
    log "internal stock publisher ready"
    break
  fi
  if ! kill -0 "$stock_pid" >/dev/null 2>&1; then
    log "internal stock publisher exited"
    wait "$stock_pid"
    exit 1
  fi
  if [[ "$i" == "120" ]]; then
    log "internal stock publisher did not become ready"
    exit 1
  fi
  sleep 1
done

export MEMWAL_PUBLISHER_UPSTREAM_URL="${MEMWAL_PUBLISHER_UPSTREAM_URL:-http://${STOCK_BIND_ADDRESS}}"
export MEMWAL_PUBLISHER_JWT_SECRET="$JWT_SECRET"
export SUI_WALLET_CONFIG="${SUI_WALLET_CONFIG:-/config/wallet-config.yml}"
export WALRUS_CONFIG="${WALRUS_CONFIG:-/config/client-config.yml}"

log "starting MemWal publisher on ${MEMWAL_PUBLISHER_BIND_ADDRESS:-0.0.0.0:31416}"
exec memwal-publisher
