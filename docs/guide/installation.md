# Installation

## Package Installation

Install the MemWal SDK using pnpm:

```bash
pnpm add @cmdoss/memwal
```

Or with npm:

```bash
npm install @cmdoss/memwal
```

## Environment Variables

Set up your environment variables:

```bash
VITE_ENOKI_API_KEY=your_enoki_api_key
VITE_GOOGLE_CLIENT_ID=your_google_client_id
VITE_SUI_NETWORK=testnet
VITE_MEMWAL_PACKAGE_ID=your_package_id
```

## Required Packages

MemWal requires:

- `@mysten/sui` - Sui TypeScript SDK
- `@mysten/enoki` - Enoki zkLogin
- `@mysten/dapp-kit` - Wallet connection
- `@mysten/walrus` - Walrus storage
- `@mysten/seal` - SEAL encryption
