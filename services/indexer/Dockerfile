# ============================================================
# Walrus Memory Indexer — checkpoint-ingestion (sui-indexer-alt-framework)
# Reads static checkpoint files from a public bucket; no fullnode event API.
# ============================================================

FROM rust:1-bookworm AS builder
WORKDIR /app
# libpq-dev: diesel/postgres links pq-sys at build. cmake: aws-lc-sys (framework TLS).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev pkg-config cmake \
    && rm -rf /var/lib/apt/lists/*
# crates.io + the Sui git dep flake on HTTP/2 framing under load; retry + disable mux.
ENV CARGO_NET_RETRY=10 CARGO_HTTP_MULTIPLEXING=false

# Dep-cache layer: compile the (heavy) dependency graph against a dummy main so a
# source-only change reuses it instead of recompiling the Sui git deps.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src
COPY src/ src/
COPY migrations/ migrations/
RUN touch src/main.rs && cargo build --release

# ── Runtime ─────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libpq5 \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -ms /bin/bash appuser
USER appuser
WORKDIR /app
COPY --from=builder --chown=appuser:appuser /app/target/release/memwal-indexer ./memwal-indexer

# Testnet-safe defaults. Production overrides both values with the mainnet
# checkpoint bucket and a checkpoint before the mainnet package publish.
# `--first-checkpoint` is used only until a database watermark exists.
ENV INDEXER_REMOTE_STORE_URL=https://checkpoints.testnet.sui.io \
    INDEXER_FIRST_CHECKPOINT=360074900
CMD ["sh", "-c", "exec ./memwal-indexer --remote-store-url \"$INDEXER_REMOTE_STORE_URL\" --first-checkpoint \"$INDEXER_FIRST_CHECKPOINT\""]
