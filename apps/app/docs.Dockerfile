# Docs only - build and serve VitePress files
FROM node:18-alpine

RUN npm install -g serve vitepress

WORKDIR /app

# Copy full repo (monorepo)
COPY . .

# Build docs - docs is in apps/app/docs/
RUN cd apps/app && npx vitepress build docs

# Serve docs from the built location
EXPOSE ${PORT:-3000}

CMD ["serve", "-s", "apps/app/docs/dist", "-l", "${PORT:-3000}"]
