# Docs only - build and serve VitePress files
FROM node:18-alpine

RUN npm install -g serve vitepress

WORKDIR /app

# Copy docs source
COPY docs/ ./docs/

# Build docs
RUN npx vitepress build docs

# Serve docs on port
EXPOSE ${PORT:-3000}

CMD ["serve", "-s", "docs/dist", "-l", "${PORT:-3000}"]
