# ============================================================
# memwal Indexer — Dockerfile
# Pure Rust binary — indexes Sui on-chain events
# ============================================================

# ── Stage 1: Build Rust binary ──────────────────────────────
FROM rust:1.85-bookworm AS builder

WORKDIR /app

# Cache dependencies — copy manifests first
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release && rm -rf src

# Build real source
COPY src/ src/
RUN touch src/main.rs
RUN cargo build --release

# ── Stage 2: Runtime ────────────────────────────────────────
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/target/release/memwal-indexer ./memwal-indexer

CMD ["./memwal-indexer"]
