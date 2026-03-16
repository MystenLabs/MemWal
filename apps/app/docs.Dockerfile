# Docs only - serve static VitePress files
FROM node:22-alpine

RUN npm install -g serve

WORKDIR /app

# Copy docs source
COPY docs/ ./docs/

# Build docs with vitepress
RUN npm install -g vitepress && npx vitepress build docs

# Serve docs on port 3000
EXPOSE 3000

CMD ["serve", "-s", "docs/.vitepress/dist", "-l", "3000"]
