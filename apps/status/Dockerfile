# ============================================================
# Walrus Memory Status — standalone status service
# Build context: repo root (Railway Root Directory = /)
# ============================================================

FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/status/package.json ./apps/status/

RUN pnpm install --frozen-lockfile

COPY apps/status/ ./apps/status/

RUN pnpm --filter @memwal/status build

FROM node:22-alpine AS runtime

WORKDIR /app

COPY --from=builder /app/apps/status/dist ./dist
COPY --from=builder /app/apps/status/server.mjs ./server.mjs

ENV NODE_ENV=production
ENV PORT=3000
ENV STATUS_RELAYER_URL=https://relayer.memory.walrus.xyz
EXPOSE 3000

CMD ["node", "server.mjs"]
