# Build stage
FROM oven/bun:1.1.38-debian AS builder

# Install build dependencies for native modules (hnswlib-node)
RUN apt-get update && apt-get install -y \
    python3 \
    build-essential \
    g++ \
    make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better caching
COPY package.json bun.lock ./
COPY packages/memwal-sdk/package.json ./packages/memwal-sdk/
COPY apps/showcase/package.json ./apps/showcase/

# Install dependencies (including native modules)
RUN bun install

# Copy source code
COPY . .

# Build SDK first, then showcase
RUN bun run build:sdk
RUN bun run build:showcase

# Production stage
FROM oven/bun:1.1.38-debian AS runner

# Install runtime dependencies for native modules
RUN apt-get update && apt-get install -y \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built artifacts and dependencies
COPY --from=builder /app/package.json ./
COPY --from=builder /app/bun.lock ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/showcase ./apps/showcase

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Start the application
CMD ["bun", "run", "start"]
