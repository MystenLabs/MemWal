# Use Node.js 20 LTS (slim variant for smaller image)
FROM node:20-slim

# Install necessary system dependencies for native modules
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files from monorepo root and showcase app
COPY package.json bun.lock* package-lock.json* ./
COPY apps/showcase/package.json ./apps/showcase/
COPY packages/memwal-sdk/package.json ./packages/memwal-sdk/

# Install dependencies using npm (Node.js native)
# Use --legacy-peer-deps if there are peer dependency conflicts
RUN npm install --legacy-peer-deps || npm install

# Copy source code
COPY . .

# Build the SDK first
WORKDIR /app/packages/memwal-sdk
RUN npm run build

# Build the Next.js app
WORKDIR /app/apps/showcase
RUN npm run build

# Expose the port Next.js runs on
EXPOSE 3000

# Set environment to production
ENV NODE_ENV=production

# Start the application with Node.js
CMD ["node", "node_modules/next/dist/server/lib/start-server.js"]
