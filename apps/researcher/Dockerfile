# ============================================================
# Researcher App (Next.js) — Dockerfile
#
# BUILD FROM MONOREPO ROOT:
#     docker build -f apps/researcher/Dockerfile -t researcher .
# ============================================================

# ── Stage 1: Dependencies ──────────────────────────────────
FROM oven/bun:1 AS deps

WORKDIR /app

COPY apps/researcher/package.json ./

# Install deps — @mysten-incubation/memwal is now on npm, no local SDK needed
RUN bun install --frozen-lockfile

# ── Stage 2: Build ─────────────────────────────────────────
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules/ node_modules/
COPY apps/researcher/ .

# Next.js collects telemetry by default — disable it
ENV NEXT_TELEMETRY_DISABLED=1

# Server-only env vars — dummies for build, real values at runtime
ENV POSTGRES_URL="postgresql://dummy:dummy@localhost:5432/dummy"
ENV AUTH_SECRET="build-time-placeholder"

# NEXT_PUBLIC_* vars are inlined into the client bundle at build time.
# Railway passes env vars as Docker build args automatically.
ARG NEXT_PUBLIC_ENOKI_API_KEY
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID
ARG NEXT_PUBLIC_SUI_NETWORK
ARG NEXT_PUBLIC_MEMWAL_PACKAGE_ID
ARG NEXT_PUBLIC_MEMWAL_REGISTRY_ID
ARG NEXT_PUBLIC_MEMWAL_SERVER_URL

ENV NEXT_PUBLIC_ENOKI_API_KEY=$NEXT_PUBLIC_ENOKI_API_KEY
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID
ENV NEXT_PUBLIC_SUI_NETWORK=$NEXT_PUBLIC_SUI_NETWORK
ENV NEXT_PUBLIC_MEMWAL_PACKAGE_ID=$NEXT_PUBLIC_MEMWAL_PACKAGE_ID
ENV NEXT_PUBLIC_MEMWAL_REGISTRY_ID=$NEXT_PUBLIC_MEMWAL_REGISTRY_ID
ENV NEXT_PUBLIC_MEMWAL_SERVER_URL=$NEXT_PUBLIC_MEMWAL_SERVER_URL

RUN bunx next build

# ── Stage 3: Runtime ───────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Copy Next.js standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy DB migration files + drizzle deps (not included in standalone output)
COPY --from=builder /app/lib/db/ ./lib/db/
COPY --from=builder /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=builder /app/node_modules/postgres ./node_modules/postgres
COPY --from=builder /app/node_modules/dotenv ./node_modules/dotenv

# Install tsx for running TypeScript migration at startup
RUN npm install -g tsx

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
EXPOSE 3000

CMD ["sh", "-c", "tsx lib/db/migrate.ts && node server.js"]
