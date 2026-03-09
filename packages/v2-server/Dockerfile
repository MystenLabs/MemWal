# ============================================================
# MemWal V2 Server — Dockerfile
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

# ── Stage 2: Runtime (Debian slim + Node.js) ────────────────
FROM debian:bookworm-slim AS runtime

# Install runtime deps + Node.js 22
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    libssl3 \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Rust binary
COPY --from=builder /app/target/release/memwal-v2-server ./memwal-v2-server

# Copy TS sidecar scripts + install deps
COPY scripts/package.json scripts/package-lock.json ./scripts/
RUN cd scripts && npm ci --omit=dev
COPY scripts/*.ts ./scripts/

# Copy migrations (for reference / manual runs)
COPY migrations/ ./migrations/

# Railway injects PORT env var
ENV PORT=3001
EXPOSE ${PORT}

CMD ["./memwal-v2-server"]
