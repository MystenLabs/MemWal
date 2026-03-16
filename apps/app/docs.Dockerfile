# Docs only - build and serve VitePress files
FROM node:18-alpine

RUN npm install -g serve vitepress

WORKDIR /app

# Copy only docs folder (build context is repo root)
COPY apps/app/docs/ ./docs/

# Build docs
RUN npx vitepress build docs

# Serve docs from the built location
EXPOSE ${PORT:-8080}

CMD ["serve", "-s", "docs/dist", "-l", "${PORT:-8080}"]
