# ============================================================
# Walrus Memory App Auth Demo — Dockerfile
#
# Build from monorepo root:
#   docker build -f apps/app-auth-demo/Dockerfile -t memwal-app-auth-demo .
#
# Root Directory on Railway must be "/" (repo root).
# ============================================================

FROM node:22-alpine AS runtime

WORKDIR /app/apps/app-auth-demo

COPY apps/app-auth-demo/package.json ./
COPY apps/app-auth-demo/src ./src

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
