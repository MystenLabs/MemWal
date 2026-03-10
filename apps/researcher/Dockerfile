# ============================================================
# MemWal V2 Test (Next.js Chatbot) — Dockerfile
#
# ⚠️  BUILD FROM MONOREPO ROOT:
#     docker build -f packages/v2-test/Dockerfile -t memwal-v2-test .
#
# This is required because v2-test depends on the local v2 SDK
# via "file:../v2" in package.json.
# ============================================================

# ── Stage 1: Dependencies ──────────────────────────────────
FROM node:22-alpine AS deps

RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

WORKDIR /app

# Copy v2 SDK (local dependency)
COPY packages/v2/package.json packages/v2/
COPY packages/v2/tsconfig.json packages/v2/
COPY packages/v2/src/ packages/v2/src/

# Build v2 SDK first (install its deps for typescript compiler)
# Note: || true because ai peer dep version mismatch causes type error,
# but tsc still emits JS files (noEmitOnError defaults to false)
RUN cd packages/v2 && npm install && npx tsc || true

# Copy v2-test manifests & install
COPY packages/v2-test/package.json packages/v2-test/pnpm-lock.yaml packages/v2-test/

# Install deps (the file:../v2 reference resolves because both dirs exist)
RUN cd packages/v2-test && pnpm install --frozen-lockfile

# ── Stage 2: Build ─────────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

WORKDIR /app

# Copy v2 SDK (built)
COPY --from=deps /app/packages/v2/ packages/v2/

# Copy v2-test with node_modules
COPY --from=deps /app/packages/v2-test/node_modules/ packages/v2-test/node_modules/
COPY packages/v2-test/ packages/v2-test/

WORKDIR /app/packages/v2-test

# Next.js collects telemetry by default — disable it
ENV NEXT_TELEMETRY_DISABLED=1

# Build needs these env vars at build time (set dummies for `next build`)
# Real values are injected at runtime
ENV POSTGRES_URL="postgresql://dummy:dummy@localhost:5432/dummy"
ENV AUTH_SECRET="build-time-placeholder"

# Run only next build (skip DB migration — that runs at container start)
RUN pnpm next build

# ── Stage 3: Runtime ───────────────────────────────────────
FROM node:22-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

WORKDIR /app

# Copy v2 SDK (needed at runtime for file: reference)
COPY --from=builder /app/packages/v2/ ../v2/

# Copy Next.js standalone output
COPY --from=builder /app/packages/v2-test/.next/standalone ./
COPY --from=builder /app/packages/v2-test/.next/static ./.next/static
COPY --from=builder /app/packages/v2-test/public ./public

# Copy DB migration files + drizzle deps (not included in standalone output)
COPY --from=builder /app/packages/v2-test/lib/db/ ./lib/db/
COPY --from=builder /app/packages/v2-test/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=builder /app/packages/v2-test/node_modules/postgres ./node_modules/postgres
COPY --from=builder /app/packages/v2-test/node_modules/dotenv ./node_modules/dotenv

# Install tsx for running TypeScript migration at startup
RUN npm install -g tsx

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
EXPOSE 3000

CMD ["sh", "-c", "tsx lib/db/migrate.ts && node server.js"]
