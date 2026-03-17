# ============================================================
# MemWal Docs — Dockerfile
# VitePress static site — build + serve
# Build context: repo root (Railway Root Directory = /)
# ============================================================

FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

WORKDIR /app

# Copy workspace root + docs
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY docs/ ./docs/

# Install deps (only what docs needs)
RUN pnpm install

# Build VitePress docs
RUN pnpm build:docs

# ── Stage 2: Serve static files ─────────────────────────────
FROM node:22-alpine AS runtime

RUN npm install -g serve

WORKDIR /app

COPY --from=builder /app/docs/dist ./dist

ENV PORT=3000
EXPOSE 3000

CMD ["serve", "-s", "-l", "3000", "dist"]
