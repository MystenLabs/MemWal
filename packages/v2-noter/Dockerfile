# ============================================================
# MemWal V2 Noter — Dockerfile
#
# ⚠️  BUILD FROM MONOREPO ROOT:
#     docker build -f packages/v2-noter/Dockerfile -t memwal-v2-noter .
#
# This is required because v2-noter depends on the local v2 SDK
# via "file:../v2" in package.json.
# ============================================================

# ── Stage 1: Dependencies ──────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

# Copy v2 SDK (local dependency)
COPY packages/v2/package.json packages/v2/
COPY packages/v2/tsconfig.json packages/v2/
COPY packages/v2/src/ packages/v2/src/

# Build v2 SDK first (install its deps for typescript compiler)
# Note: || true because ai peer dep version mismatch causes type error,
# but tsc still emits JS files (noEmitOnError defaults to false)
RUN cd packages/v2 && npm install && npx tsc || true

# Copy v2-noter manifests & install
COPY packages/v2-noter/package.json packages/v2-noter/package-lock.json* packages/v2-noter/

# Install deps (the file:../v2 reference resolves because both dirs exist)
RUN cd packages/v2-noter && npm install

# ── Stage 2: Build ─────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy v2 SDK (built)
COPY --from=deps /app/packages/v2/ packages/v2/

# Copy v2-noter with node_modules
COPY --from=deps /app/packages/v2-noter/node_modules/ packages/v2-noter/node_modules/
COPY packages/v2-noter/ packages/v2-noter/

# Fix SDK resolution: copy built SDK directly into node_modules
# (file:../v2 symlink breaks across Docker stages, Turbopack can't resolve symlinks)
RUN rm -rf packages/v2-noter/node_modules/@cmdoss/memwal-v2 && \
    cp -r packages/v2 packages/v2-noter/node_modules/@cmdoss/memwal-v2

WORKDIR /app/packages/v2-noter

# Next.js collects telemetry by default — disable it
ENV NEXT_TELEMETRY_DISABLED=1

# Build needs these env vars at build time (set dummies for `next build`)
# Real values are injected at runtime
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"

# Run next build
RUN npx next build

# ── Stage 3: Runtime ───────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Copy v2 SDK (needed at runtime for file: reference)
COPY --from=builder /app/packages/v2/ ../v2/

# Copy Next.js standalone output
COPY --from=builder /app/packages/v2-noter/.next/standalone ./
COPY --from=builder /app/packages/v2-noter/.next/static ./.next/static
COPY --from=builder /app/packages/v2-noter/public ./public

# Copy DB migration files + migrate script (not included in standalone output)
COPY --from=builder /app/packages/v2-noter/package/shared/db/ ./package/shared/db/
COPY --from=builder /app/packages/v2-noter/package/shared/lib/db/ ./package/shared/lib/db/
COPY --from=builder /app/packages/v2-noter/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=builder /app/packages/v2-noter/node_modules/postgres ./node_modules/postgres
COPY --from=builder /app/packages/v2-noter/node_modules/dotenv ./node_modules/dotenv

# Install tsx for running TypeScript migration at startup
RUN npm install -g tsx

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
EXPOSE 3000

CMD ["sh", "-c", "tsx package/shared/lib/db/migrate.ts && node server.js"]
