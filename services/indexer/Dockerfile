# ============================================================
# Walrus Memory Indexer — Dockerfile
# Checkpoint-ingestion indexer (sui-indexer-alt-framework).
# ============================================================

# ── Stage 1: Build ──────────────────────────────────────────
# rust 1.90+: the framework graph (roaring 0.11 -> rustc 1.90, tonic 0.14 -> 1.88)
# raises the MSRV above older images.
FROM rust:1.90-bookworm AS builder
WORKDIR /app

# Cache dependencies — copy manifests first. Migrations are embedded at compile
# time (embed_migrations!), so the migrations dir must be present for the build.
COPY Cargo.toml Cargo.lock* ./
COPY migrations ./migrations
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release || true
RUN rm -rf src

# Build real source
COPY src/ src/
RUN touch src/main.rs
RUN cargo build --release

# ── Stage 2: Runtime ────────────────────────────────────────
FROM debian:bookworm-slim AS runtime
# libpq5: Diesel's postgres backend links libpq at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    libpq5 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN useradd -ms /bin/bash appuser
USER appuser
WORKDIR /app

COPY --from=builder --chown=appuser:appuser /app/target/release/memwal-indexer ./memwal-indexer

# Ingestion args are CLI flags (clap). --remote-store-url is required; on the FIRST
# run (no watermark yet) also pass --first-checkpoint <package-deploy-cp> for a full
# backfill, or a near-tip value to only capture new accounts. Override via the
# Railway start command. DATABASE_URL + MEMWAL_PACKAGE_ID come from the environment.
ENTRYPOINT ["./memwal-indexer"]
CMD ["--remote-store-url", "https://checkpoints.mainnet.sui.io"]
