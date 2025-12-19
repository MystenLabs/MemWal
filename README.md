# MemWal Monorepo

A monorepo containing the MemWal SDK and showcase application.

## Structure

```
memwal/
├── apps/
│   └── showcase/        # Next.js showcase website (deploys to Railway)
├── packages/
│   └── memwal-sdk/      # MemWal SDK package (publishes to npm)
├── package.json         # Bun workspaces configuration
└── .changeset/          # Package versioning
```

## Quick Start

```bash
# Install dependencies
bun install

# Start showcase dev server
bun run dev:showcase

# Build SDK
bun run build:sdk

# Build everything
bun run build
```

## Development

### Showcase App (`apps/showcase/`)
- **Framework**: Next.js 14
- **Deployment**: Railway
- **Environment**: Uses `.env` file for configuration
- **SDK Dependency**: Uses workspace reference to local SDK

### MemWal SDK (`packages/memwal-sdk/`)
- **Package**: `@cmdoss/memwal-sdk`
- **Registry**: npm
- **Dependencies**: Sui, Walrus, SEAL, AI SDK integration

## Scripts

```bash
# Development
bun run dev:showcase      # Start showcase app
bun run dev:sdk          # Watch SDK in development mode

# Building
bun run build            # Build both SDK and showcase
bun run build:sdk        # Build SDK only
bun run build:showcase   # Build showcase only

# Publishing
bun run changeset        # Create changeset
bun run version          # Version packages
bun run release          # Publish to npm
```

## Package Manager

This project uses **Bun** as the package manager with workspaces enabled.

## Deployment

- **Showcase**: Deploys to Railway from `apps/showcase/`
- **SDK**: Publishes to npm from `packages/memwal-sdk/`