# ============================================================
# memwal Server — Dockerfile
# Multi-stage build: Rust binary + Node.js sidecar scripts
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
COPY migrations/ migrations/
# Touch main.rs to invalidate the cache for the actual source
RUN touch src/main.rs
RUN cargo build --release

# ── Stage 2: Runtime (Node.js slim) ─────────────────────────
FROM node:22-bookworm-slim AS runtime

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
