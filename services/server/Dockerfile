# ============================================================
# memwal Server — Dockerfile
# Multi-stage build: Rust binary + Node.js sidecar scripts
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

# ── Stage 2: Runtime (Node.js slim) ─────────────────────────
# LOW-28: pinned by digest for reproducible, supply-chain-safe builds.
# Tag: node:22-bookworm-slim  |  arch: linux/amd64  |  pinned: 2026-04-16
# To refresh: docker inspect --format='{{index .RepoDigests 0}}' node:22-bookworm-slim
FROM node:22-bookworm-slim@sha256:db9a3a15e8e8e2adbaf1e1c3d93dfb04c2e294bdd027490addb2391b8e61cc6a AS runtime

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

# Copy TS sidecar scripts + install deps
COPY --chown=appuser:appuser scripts/package.json scripts/package-lock.json ./scripts/
RUN cd scripts && npm ci --omit=dev
COPY --chown=appuser:appuser scripts/*.ts ./scripts/

# Copy migrations (for reference / manual runs)
COPY --chown=appuser:appuser migrations/ ./migrations/

# Port config — must match defaults in types.rs + sidecar-server.ts
ENV PORT=8000
ENV SIDECAR_PORT=9000
ENV SIDECAR_URL=http://localhost:9000
ENV SIDECAR_SCRIPTS_DIR=/app/scripts
EXPOSE ${PORT}

CMD ["./memwal-server"]
