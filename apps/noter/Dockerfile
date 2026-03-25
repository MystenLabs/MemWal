# ============================================================
# MemWal Noter — Dockerfile
#
# ⚠️  BUILD FROM MONOREPO ROOT:
#     docker build -f apps/noter/Dockerfile -t memwal-noter .
#
# Root Directory on Railway must be "/" (repo root)
# so build context includes packages/sdk for workspace:* resolution.
# ============================================================

# ── Stage 1: Dependencies ──────────────────────────────────
FROM node:22-alpine AS deps

RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

WORKDIR /app

# Copy workspace manifests for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/sdk/package.json ./packages/sdk/
COPY apps/noter/package.json   ./apps/noter/

# Install all workspace deps (resolves workspace:* for @mysten-incubation/memwal)
RUN pnpm install --frozen-lockfile

# Build SDK first (@mysten-incubation/memwal is the package name — matches sdk/package.json)
COPY packages/sdk/ ./packages/sdk/
RUN pnpm --filter @mysten-incubation/memwal build

# ── Stage 2: Build Next.js App ─────────────────────────────
FROM deps AS builder

COPY apps/noter/ ./apps/noter/

WORKDIR /app/apps/noter

# Next.js collects telemetry by default — disable it
ENV NEXT_TELEMETRY_DISABLED=1

# Dummy env var required for `next build` (real value injected at runtime)
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"

RUN npx next build

# Compile migrate.ts → migrate.mjs so runtime needs no tsx/esbuild
RUN node_modules/.bin/esbuild package/shared/lib/db/migrate.ts \
    --bundle --platform=node --format=esm \
    --external:postgres --external:drizzle-orm --external:dotenv \
    --outfile=migrate.mjs

# ── Stage 3: Runtime ───────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Copy Next.js standalone output
COPY --from=builder /app/apps/noter/.next/standalone ./
COPY --from=builder /app/apps/noter/.next/static     ./apps/noter/.next/static
COPY --from=builder /app/apps/noter/public           ./apps/noter/public

# Copy DB migration files + runtime deps (not in standalone bundle)
COPY --from=builder /app/apps/noter/migrate.mjs              ./migrate.mjs
COPY --from=builder /app/apps/noter/package/shared/db/       ./package/shared/db/
COPY --from=builder /app/apps/noter/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=builder /app/apps/noter/node_modules/postgres     ./node_modules/postgres
COPY --from=builder /app/apps/noter/node_modules/dotenv       ./node_modules/dotenv

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

# Run DB migration then start Next.js server
CMD ["sh", "-c", "node migrate.mjs && node apps/noter/server.js"]
