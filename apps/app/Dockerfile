# ============================================================
# MemWal V2 App — Dockerfile
# Vite React SPA — build + serve static files
# Build context: repo root (Railway Root Directory = /)
# ============================================================

# ── Stage 1: Build ──────────────────────────────────────────
FROM node:22-alpine AS builder

# Install pnpm (matches packageManager in root package.json)
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/sdk/package.json ./packages/sdk/
COPY apps/app/package.json      ./apps/app/

# Install all workspace deps
RUN pnpm install

# Build SDK first (apps/app depends on @cmdoss/memwal via workspace:*)
COPY packages/sdk/ ./packages/sdk/
RUN pnpm --filter @cmdoss/memwal build

# Copy app source (including public folder structure) BEFORE building docs
COPY apps/app/ ./apps/app/

# Build docs (outputs to apps/app/public/docs)
COPY docs/ ./docs/
RUN pnpm build:docs

# Vite env vars must be injected at build time
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

RUN pnpm --filter @memwal/app build

# ── Stage 2: Serve static files ─────────────────────────────
FROM node:22-alpine AS runtime

RUN npm install -g serve

WORKDIR /app

COPY --from=builder /app/apps/app/dist ./dist

ENV PORT=${PORT}
EXPOSE ${PORT}

# Serve with single-page-app mode (no custom rewrites)
CMD sh -c "serve -s -l ${PORT} dist"
