# ============================================================
# Walrus Memory Status — standalone status service
# Build context: repo root (Railway Root Directory = /)
# ============================================================

FROM node:22.23.4-alpine@sha256:ebc216c22db53dbde85719a874978d5aec04e6e405ad26a3804c6f9abc4ca1a9 AS builder

RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/status/package.json ./apps/status/

RUN pnpm install --frozen-lockfile

COPY apps/status/ ./apps/status/

RUN pnpm --filter @memwal/status build

FROM node:22.23.4-alpine@sha256:ebc216c22db53dbde85719a874978d5aec04e6e405ad26a3804c6f9abc4ca1a9 AS runtime

WORKDIR /app/apps/status

COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/apps/status/node_modules ./node_modules
COPY --from=builder /app/apps/status/dist ./dist
COPY --from=builder /app/apps/status/package.json ./package.json
COPY --from=builder /app/apps/status/server.mjs ./server.mjs

ENV NODE_ENV=production
ENV PORT=3000
ENV STATUS_RELAYER_PRODUCTION_URL=https://relayer.memory.walrus.xyz
ENV STATUS_RELAYER_STAGING_URL=https://relayer-staging.memory.walrus.xyz
ENV STATUS_POLL_INTERVAL_MS=60000
ENV STATUS_HISTORY_DAYS=90
EXPOSE 3000

CMD ["node", "server.mjs"]
