# ============================================================
# Walrus Memory App — Dockerfile
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
ARG VITE_GA_MEASUREMENT_ID
ARG VITE_GTM_CONTAINER_ID
ARG VITE_ANALYTICS_ALLOWED_HOSTS
ARG VITE_POSTHOG_PROJECT_API_KEY
ARG VITE_POSTHOG_KEY
ARG VITE_POSTHOG_HOST
ARG VITE_POSTHOG_UI_HOST

ENV VITE_MEMWAL_SERVER_URL=$VITE_MEMWAL_SERVER_URL
ENV VITE_MEMWAL_PACKAGE_ID=$VITE_MEMWAL_PACKAGE_ID
ENV VITE_MEMWAL_REGISTRY_ID=$VITE_MEMWAL_REGISTRY_ID
ENV VITE_SUI_NETWORK=$VITE_SUI_NETWORK
ENV VITE_ENOKI_API_KEY=$VITE_ENOKI_API_KEY
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
ENV VITE_DOCS_URL=$VITE_DOCS_URL
ENV VITE_DEMO_URLS=$VITE_DEMO_URLS
ENV VITE_GA_MEASUREMENT_ID=$VITE_GA_MEASUREMENT_ID
ENV VITE_GTM_CONTAINER_ID=$VITE_GTM_CONTAINER_ID
ENV VITE_ANALYTICS_ALLOWED_HOSTS=$VITE_ANALYTICS_ALLOWED_HOSTS
ENV VITE_POSTHOG_PROJECT_API_KEY=$VITE_POSTHOG_PROJECT_API_KEY
ENV VITE_POSTHOG_KEY=$VITE_POSTHOG_KEY
ENV VITE_POSTHOG_HOST=$VITE_POSTHOG_HOST
ENV VITE_POSTHOG_UI_HOST=$VITE_POSTHOG_UI_HOST

RUN pnpm --filter @memwal/app build

# ── Stage 2: Serve static files ─────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

COPY --from=builder /app/apps/app/dist ./dist
COPY --from=builder /app/apps/app/server.mjs ./server.mjs

ENV PORT=3000
EXPOSE 3000

# SPA mode for app routes only. File-like paths never fall back to index.html.
CMD ["node", "server.mjs"]
