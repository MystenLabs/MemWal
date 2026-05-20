#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-${MEMWAL_RUNTIME_ENV_FILE:-}}"
if [[ -n "$ENV_FILE" ]]; then
    if [[ ! -f "$ENV_FILE" ]]; then
        echo "runtime env file not found: $ENV_FILE" >&2
        exit 1
    fi

    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ -z "$line" || "$line" == \#* ]] && continue
        [[ "$line" == *=* ]] && export "$line"
    done < "$ENV_FILE"
fi

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "missing required command: $1" >&2
        exit 1
    fi
}

extract_url_host() {
    printf '%s' "$1" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://([^@/]+@)?(\[[^]]+\]|[^/:]+).*#\2#'
}

extract_url_port() {
    local url="$1"
    local explicit_port
    explicit_port=$(printf '%s' "$url" | sed -nE 's#^[a-zA-Z][a-zA-Z0-9+.-]*://([^@/]+@)?(\[[^]]+\]|[^/:]+):([0-9]+).*$#\3#p')
    if [[ -n "$explicit_port" ]]; then
        printf '%s' "$explicit_port"
        return
    fi

    case "$url" in
        https://*) printf '443' ;;
        http://*) printf '80' ;;
        redis://*|rediss://*) printf '6379' ;;
        postgresql://*|postgres://*) printf '5432' ;;
        *) printf '443' ;;
    esac
}

start_vsock_to_tcp() {
    local name="$1"
    local url="$2"
    local vsock_port="$3"
    local host
    local port

    if [[ -z "$url" || -z "$vsock_port" ]]; then
        return
    fi

    host=$(extract_url_host "$url")
    port=$(extract_url_port "$url")
    if [[ -z "$host" || -z "$port" ]]; then
        echo "skipping $name proxy; could not parse URL: $url" >&2
        return
    fi

    echo "forwarding enclave VSOCK:${vsock_port} -> ${host}:${port} ($name)"
    socat "VSOCK-LISTEN:${vsock_port},reuseaddr,fork" "TCP:${host}:${port}" &
    pids+=("$!")
}

require_cmd socat

if [[ -z "${ENCLAVE_CID:-}" ]]; then
    require_cmd jq
    require_cmd nitro-cli
    ENCLAVE_CID=$(sudo nitro-cli describe-enclaves | jq -r '.[0].EnclaveCID // empty')
fi

if [[ -z "${ENCLAVE_CID:-}" ]]; then
    echo "ENCLAVE_CID is not set and no running enclave was found" >&2
    exit 1
fi

HOST_BIND_ADDR="${HOST_BIND_ADDR:-127.0.0.1}"
HOST_HTTP_PORT="${HOST_HTTP_PORT:-8000}"
TEE_HTTP_VSOCK_PORT="${TEE_HTTP_VSOCK_PORT:-8000}"

pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true' INT TERM EXIT

echo "forwarding ${HOST_BIND_ADDR}:${HOST_HTTP_PORT} -> enclave ${ENCLAVE_CID}:${TEE_HTTP_VSOCK_PORT}"
socat "TCP-LISTEN:${HOST_HTTP_PORT},bind=${HOST_BIND_ADDR},reuseaddr,fork" "VSOCK-CONNECT:${ENCLAVE_CID}:${TEE_HTTP_VSOCK_PORT}" &
pids+=("$!")

start_vsock_to_tcp "Sui RPC" "${SUI_RPC_URL:-}" "${SUI_PROXY_VSOCK_PORT:-}"
start_vsock_to_tcp "Walrus publisher" "${WALRUS_PUBLISHER_URL:-}" "${WALRUS_PUBLISHER_PROXY_VSOCK_PORT:-}"
start_vsock_to_tcp "Walrus aggregator" "${WALRUS_AGGREGATOR_URL:-}" "${WALRUS_AGGREGATOR_PROXY_VSOCK_PORT:-}"
start_vsock_to_tcp "Walrus upload relay" "${WALRUS_UPLOAD_RELAY_URL:-}" "${WALRUS_UPLOAD_RELAY_PROXY_VSOCK_PORT:-}"
start_vsock_to_tcp "OpenAI-compatible API" "${OPENAI_API_BASE:-}" "${OPENAI_PROXY_VSOCK_PORT:-}"

if [[ -n "${DATABASE_URL:-}" && -n "${POSTGRES_PROXY_VSOCK_PORT:-}" ]]; then
    pg_host=$(printf '%s' "$DATABASE_URL" | sed -nE 's#^[^:]+://([^@]+@)?([^:/@]+).*#\2#p')
    pg_port=$(printf '%s' "$DATABASE_URL" | sed -nE 's#^[^:]+://([^@]+@)?[^:/@]+:([0-9]+).*#\2#p')
    pg_port="${pg_port:-5432}"
    if [[ -n "$pg_host" ]]; then
        echo "forwarding enclave VSOCK:${POSTGRES_PROXY_VSOCK_PORT} -> ${pg_host}:${pg_port} (PostgreSQL)"
        socat "VSOCK-LISTEN:${POSTGRES_PROXY_VSOCK_PORT},reuseaddr,fork" "TCP:${pg_host}:${pg_port}" &
        pids+=("$!")
    fi
fi

if [[ -n "${REDIS_URL:-}" && -n "${REDIS_PROXY_VSOCK_PORT:-}" ]]; then
    redis_host=$(extract_url_host "$REDIS_URL")
    redis_port=$(extract_url_port "$REDIS_URL")
    if [[ -n "$redis_host" ]]; then
        echo "forwarding enclave VSOCK:${REDIS_PROXY_VSOCK_PORT} -> ${redis_host}:${redis_port} (Redis)"
        socat "VSOCK-LISTEN:${REDIS_PROXY_VSOCK_PORT},reuseaddr,fork" "TCP:${redis_host}:${redis_port}" &
        pids+=("$!")
    fi
fi

if [[ -n "${SEAL_KEY_SERVER_URLS:-}" && -n "${SEAL_BASE_VSOCK_PORT:-}" ]]; then
    IFS=',' read -r -a seal_urls <<< "$SEAL_KEY_SERVER_URLS"
    for idx in "${!seal_urls[@]}"; do
        start_vsock_to_tcp "SEAL key server ${idx}" "${seal_urls[$idx]}" "$((SEAL_BASE_VSOCK_PORT + idx))"
    done
fi

echo "forwarding active; test with: curl http://${HOST_BIND_ADDR}:${HOST_HTTP_PORT}/health"
wait
