# ============================================
# v2-noter Dockerfile for Railway Deployment
# ============================================

# Build stage
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y \
    python3 \
    build-essential \
    g++ \
    make \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy root workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy package manifests
COPY packages/v2/package.json ./packages/v2/
COPY packages/v2-noter/package.json ./packages/v2-noter/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/v2 ./packages/v2
COPY packages/v2-noter ./packages/v2-noter

# Build SDK first
WORKDIR /app/packages/v2
RUN pnpm build

# Build noter app
WORKDIR /app/packages/v2-noter
RUN pnpm build

# Production stage
FROM node:20-slim AS runner

WORKDIR /app

COPY --from=builder /app/packages/v2-noter/.next/standalone ./
COPY --from=builder /app/packages/v2-noter/.next/static ./packages/v2-noter/.next/static
COPY --from=builder /app/packages/v2-noter/public ./packages/v2-noter/public

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "packages/v2-noter/server.js"]
