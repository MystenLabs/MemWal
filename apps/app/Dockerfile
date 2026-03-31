# ============================================================
# memwal App — Dockerfile
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
RUN pnpm install --frozen-lockfile

# Build SDK first (apps/app depends on @mysten-incubation/memwal via workspace:*)
COPY packages/sdk/ ./packages/sdk/
RUN pnpm --filter @mysten-incubation/memwal build

# Copy app source
COPY apps/app/ ./apps/app/

# Vite env vars must be injected at build time
ARG VITE_MEMWAL_SERVER_URL
ARG VITE_MEMWAL_PACKAGE_ID=0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6
ARG VITE_MEMWAL_REGISTRY_ID=0x0da982cefa26864ae834a8a0504b904233d49e20fcc17c373c8bed99c75a7edd
ARG VITE_SUI_NETWORK=mainnet
ARG VITE_ENOKI_API_KEY
ARG VITE_GOOGLE_CLIENT_ID
ARG VITE_DOCS_URL
ARG VITE_DEMO_URLS

ENV VITE_MEMWAL_SERVER_URL=$VITE_MEMWAL_SERVER_URL
ENV VITE_MEMWAL_PACKAGE_ID=$VITE_MEMWAL_PACKAGE_ID
ENV VITE_MEMWAL_REGISTRY_ID=$VITE_MEMWAL_REGISTRY_ID
ENV VITE_SUI_NETWORK=$VITE_SUI_NETWORK
ENV VITE_ENOKI_API_KEY=$VITE_ENOKI_API_KEY
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
ENV VITE_DOCS_URL=$VITE_DOCS_URL
ARG VITE_DEMO_URLS=$VITE_DEMO_URLS

RUN pnpm --filter @memwal/app build

# ── Stage 2: Serve static files ─────────────────────────────
FROM node:22-alpine AS runtime

RUN npm install -g serve

WORKDIR /app

COPY --from=builder /app/apps/app/dist ./dist

ENV PORT=${PORT}
EXPOSE ${PORT}

# SPA mode — all routes fallback to index.html
CMD sh -c "serve -s -l ${PORT} dist"
