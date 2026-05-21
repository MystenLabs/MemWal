#!/bin/sh
set -eu

load_env_file() {
    file="$1"
    if [ ! -f "$file" ]; then
        echo "runtime env file not found: $file" >&2
        exit 1
    fi

    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            ""|\#*) continue ;;
            *=*) export "$line" ;;
            *) echo "ignoring non-assignment line in $file: $line" >&2 ;;
        esac
    done < "$file"
}

if [ "${1:-}" != "" ] && [ -f "$1" ]; then
    load_env_file "$1"
    shift
elif [ "${MEMWAL_RUNTIME_ENV_FILE:-}" != "" ]; then
    load_env_file "$MEMWAL_RUNTIME_ENV_FILE"
fi

export PORT="${PORT:-8000}"
export SIDECAR_PORT="${SIDECAR_PORT:-9000}"
export SIDECAR_URL="${SIDECAR_URL:-http://127.0.0.1:9000}"
export SIDECAR_SCRIPTS_DIR="${SIDECAR_SCRIPTS_DIR:-/app/scripts}"
export LOG_FORMAT="${LOG_FORMAT:-json}"

missing=""
need() {
    var="$1"
    eval "value=\${$var:-}"
    if [ -z "$value" ]; then
        missing="${missing} ${var}"
    fi
}

need DATABASE_URL
need REDIS_URL
need MEMWAL_PACKAGE_ID
need MEMWAL_REGISTRY_ID
need SUI_NETWORK
need SUI_RPC_URL
need WALRUS_PUBLISHER_URL
need WALRUS_AGGREGATOR_URL
need OPENAI_API_KEY
need SIDECAR_AUTH_TOKEN

if [ -z "${SERVER_SUI_PRIVATE_KEY:-}" ] && [ -z "${SERVER_SUI_PRIVATE_KEYS:-}" ]; then
    missing="${missing} SERVER_SUI_PRIVATE_KEY_or_SERVER_SUI_PRIVATE_KEYS"
fi

if [ -n "$missing" ]; then
    echo "missing required runtime env:${missing}" >&2
    exit 1
fi

case "${BENCHMARK_MODE:-false}" in
    1|true|TRUE|yes|YES)
        echo "BENCHMARK_MODE must stay disabled for TEE deployments" >&2
        exit 1
        ;;
esac

if [ -z "${SEAL_SERVER_CONFIGS:-}" ] && [ -z "${SEAL_KEY_SERVERS:-}" ]; then
    echo "warning: SEAL_SERVER_CONFIGS/SEAL_KEY_SERVERS not set; sidecar will use network defaults" >&2
fi

if [ "$#" -gt 0 ]; then
    exec "$@"
fi

exec ./memwal-server
