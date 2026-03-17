# Docs only - build and serve VitePress files
FROM node:18-alpine

RUN npm install -g serve

WORKDIR /app

# Copy docs folder (build context is repo root)
COPY docs/ ./docs/
COPY docs/package.json ./docs-package.json

# Install vitepress locally in docs folder
WORKDIR /app/docs
RUN npm install vitepress

# Build docs
WORKDIR /app
RUN npx vitepress build docs

# Serve docs
EXPOSE 3000

CMD ["sh", "-c", "serve -s docs/dist -l 3000"]
