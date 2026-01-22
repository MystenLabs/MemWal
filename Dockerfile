# ============================================
# Node.js Dockerfile for Railway Deployment
# ============================================
# This uses Node.js instead of Bun for stable hnswlib-node support.
# Native C++ modules (hnswlib-node) work reliably with Node.js runtime.
#
# Note: We use Bun for installation (handles workspace:* protocol)
# but run the app with Node.js for stable native module support.

# Build stage - Use Bun for installation, Node for runtime
FROM oven/bun:1.1.38-debian AS builder

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    build-essential \
    g++ \
    make \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 alongside Bun
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files for better caching
COPY package.json bun.lock ./
COPY packages/memwal-sdk/package.json ./packages/memwal-sdk/
COPY apps/showcase/package.json ./apps/showcase/

# Install dependencies with Bun (handles workspace:* protocol)
RUN bun install

# Rebuild native modules with npm (hnswlib-node requires proper compilation)
# This ensures hnswlib-node is built with Node.js toolchain
WORKDIR /app/packages/memwal-sdk
RUN npm rebuild hnswlib-node || echo "hnswlib-node rebuild skipped"

# Copy source code
WORKDIR /app
COPY . .

# Build SDK first using npm scripts (more compatible)
WORKDIR /app/packages/memwal-sdk
RUN npm run build

# Build showcase app using npm
WORKDIR /app/apps/showcase
RUN npm run build

# Production stage - Pure Node.js runtime
FROM node:20-slim AS runner

# Install runtime dependencies for native modules
RUN apt-get update && apt-get install -y \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built artifacts and dependencies from builder
COPY --from=builder /app/package.json ./
COPY --from=builder /app/bun.lock ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/showcase ./apps/showcase

# Set environment to production
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Start the Next.js app with Node.js (not Bun!)
WORKDIR /app/apps/showcase
CMD ["node", "node_modules/next/dist/server/lib/start-server.js"]
