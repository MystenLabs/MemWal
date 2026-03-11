# ============================================================
# MemWal V2 App — Dockerfile
# Vite React SPA — build + serve static files
# Monorepo-aware: builds SDK dependency first
# ============================================================

# ── Stage 1: Build ──────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy root package files for workspace resolution
COPY package.json package-lock.json* ./

# Copy SDK package files
COPY packages/v2/package.json ./packages/v2/

# Copy v2-app package files
COPY packages/v2-app/package.json ./packages/v2-app/

# Install all dependencies (workspace-aware)
RUN npm install --legacy-peer-deps

# Copy SDK source and build it first
COPY packages/v2/ ./packages/v2/
# Install SDK peer deps at root level (workspace hoisting) for tsc to resolve
RUN npm install --no-save --legacy-peer-deps ai @ai-sdk/provider @mysten/sui @mysten/seal @mysten/walrus
RUN npm run build -w packages/v2

# Copy v2-app source
WORKDIR /app
COPY packages/v2-app/ ./packages/v2-app/

# Vite env vars must be set at build time
ARG VITE_MEMWAL_SERVER_URL
ARG VITE_MEMWAL_PACKAGE_ID=0xb625c403a26c4b985a3f2549e6115c1646b0094d39fa142016807ba015952869
ARG VITE_MEMWAL_REGISTRY_ID=0x3d46792b7676e6558707982b535092454a46e668b52c0a6d83b9a9fdecd71c46
ARG VITE_SUI_NETWORK=testnet
ARG VITE_ENOKI_API_KEY
ARG VITE_GOOGLE_CLIENT_ID

ENV VITE_MEMWAL_SERVER_URL=$VITE_MEMWAL_SERVER_URL
ENV VITE_MEMWAL_PACKAGE_ID=$VITE_MEMWAL_PACKAGE_ID
ENV VITE_MEMWAL_REGISTRY_ID=$VITE_MEMWAL_REGISTRY_ID
ENV VITE_SUI_NETWORK=$VITE_SUI_NETWORK
ENV VITE_ENOKI_API_KEY=$VITE_ENOKI_API_KEY
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

WORKDIR /app/packages/v2-app
RUN npm run build

# ── Stage 2: Serve static files ─────────────────────────────
FROM node:22-alpine AS runtime

RUN npm install -g serve

WORKDIR /app

COPY --from=builder /app/packages/v2-app/dist ./dist

ENV PORT=3000
EXPOSE 3000

CMD ["serve", "dist", "-l", "3000", "-s"]
