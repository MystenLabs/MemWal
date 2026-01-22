# ============================================
# Node.js Dockerfile for Railway Deployment
# ============================================
# This uses Node.js instead of Bun for stable hnswlib-node support.
# Native C++ modules (hnswlib-node) work reliably with Node.js runtime.

# Build stage
FROM node:20-slim AS builder

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    build-essential \
    g++ \
    make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files for better caching
COPY package.json package-lock.json* bun.lock* ./
COPY packages/memwal-sdk/package.json ./packages/memwal-sdk/
COPY apps/showcase/package.json ./apps/showcase/

# Install dependencies with npm (handles native modules better than bun)
RUN npm install --legacy-peer-deps || npm install

# Copy source code
COPY . .

# Build SDK first
WORKDIR /app/packages/memwal-sdk
RUN npm run build

# Build showcase app
WORKDIR /app/apps/showcase
RUN npm run build

# Production stage
FROM node:20-slim AS runner

# Install runtime dependencies (lighter than build deps)
RUN apt-get update && apt-get install -y \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built artifacts and dependencies from builder
COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json* ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/showcase ./apps/showcase

# Set environment to production
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Start the Next.js app with Node.js
WORKDIR /app/apps/showcase
CMD ["node", "node_modules/next/dist/server/lib/start-server.js"]
