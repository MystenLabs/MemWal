# ============================================================
# Researcher App (Next.js) — Dockerfile
#
# BUILD FROM MONOREPO ROOT:
#     docker build -f apps/researcher/Dockerfile -t researcher .
#
# The app depends on the local v2 SDK via
# "file:../../packages/v2" in package.json.
# ============================================================

# ── Stage 1: Dependencies ──────────────────────────────────
FROM oven/bun:1 AS deps

WORKDIR /app

# Copy v2 SDK (local dependency)
COPY packages/v2/package.json packages/v2/
COPY packages/v2/tsconfig.json packages/v2/
COPY packages/v2/src/ packages/v2/src/

# Build v2 SDK (install its deps for typescript compiler)
# || true because ai peer dep version mismatch causes type error,
# but tsc still emits JS files (noEmitOnError defaults to false)
RUN cd packages/v2 && bun install && bunx tsc || true

# Copy researcher manifests & lockfile
COPY apps/researcher/package.json apps/researcher/

# Install deps (the file:../../packages/v2 reference resolves)
RUN cd apps/researcher && bun install

# ── Stage 2: Build ─────────────────────────────────────────
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy v2 SDK (built)
COPY --from=deps /app/packages/v2/ packages/v2/

# Copy researcher with node_modules
COPY --from=deps /app/apps/researcher/node_modules/ apps/researcher/node_modules/
COPY apps/researcher/ apps/researcher/

WORKDIR /app/apps/researcher

# Next.js collects telemetry by default — disable it
ENV NEXT_TELEMETRY_DISABLED=1

# Build needs these env vars at build time (set dummies for `next build`)
# Real values are injected at runtime
ENV POSTGRES_URL="postgresql://dummy:dummy@localhost:5432/dummy"
ENV AUTH_SECRET="build-time-placeholder"

# Run only next build (skip DB migration — that runs at container start)
RUN bunx next build

# ── Stage 3: Runtime ───────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Copy v2 SDK (needed at runtime for file: reference)
COPY --from=builder /app/packages/v2/ ../packages/v2/

# Copy Next.js standalone output
COPY --from=builder /app/apps/researcher/.next/standalone ./
COPY --from=builder /app/apps/researcher/.next/static ./.next/static
COPY --from=builder /app/apps/researcher/public ./public

# Copy DB migration files + drizzle deps (not included in standalone output)
COPY --from=builder /app/apps/researcher/lib/db/ ./lib/db/
COPY --from=builder /app/apps/researcher/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=builder /app/apps/researcher/node_modules/postgres ./node_modules/postgres
COPY --from=builder /app/apps/researcher/node_modules/dotenv ./node_modules/dotenv

# Install tsx for running TypeScript migration at startup
RUN npm install -g tsx

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
EXPOSE 3000

CMD ["sh", "-c", "tsx lib/db/migrate.ts && node server.js"]
