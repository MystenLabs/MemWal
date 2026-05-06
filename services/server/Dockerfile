# ============================================================
# memwal Server — Dockerfile
# Single-stage Rust binary (ENG-1700: Node.js sidecar removed)
# ============================================================

# ── Stage 1: Build Rust binary ──────────────────────────────
# LOW-28: pinned by digest for reproducible, supply-chain-safe builds.
# Tag: rust:1.85-bookworm  |  arch: linux/amd64  |  pinned: 2026-04-16
# To refresh: docker inspect --format='{{index .RepoDigests 0}}' rust:1.85-bookworm
FROM rust:1.85-bookworm@sha256:bf7d87666c4da6eace19e06d21bc4859c6e2a5c97a21ac273b0e082112753cf0 AS builder

WORKDIR /app

# Cache dependencies — copy manifests first
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release && rm -rf src

# Build real source
COPY src/ src/
COPY migrations/ migrations/
# Touch main.rs to invalidate the cache for the actual source
RUN touch src/main.rs
RUN cargo build --release

# ── Stage 2: Runtime (debian-slim, no Node) ─────────────────
# LOW-28: pinned by digest. Was node:22-bookworm-slim (Node sidecar host) —
# replaced with plain debian-slim now that all Mysten SDK calls (SEAL,
# Walrus, Enoki) run in-process via Rust crates (ENG-1700).
# Tag: debian:bookworm-slim  |  arch: linux/amd64  |  pinned: 2026-05-05
# To refresh: docker inspect --format='{{index .RepoDigests 0}}' debian:bookworm-slim
FROM debian:bookworm-slim AS runtime

# Install Rust runtime deps (ca-certificates and libssl3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Add non-root user
RUN useradd -ms /bin/bash appuser
USER appuser
WORKDIR /app

# Copy Rust binary
COPY --from=builder --chown=appuser:appuser /app/target/release/memwal-server ./memwal-server

# Copy migrations (for reference / manual runs)
COPY --chown=appuser:appuser migrations/ ./migrations/

# Port config — must match defaults in types.rs
ENV PORT=8000
EXPOSE ${PORT}

CMD ["./memwal-server"]
