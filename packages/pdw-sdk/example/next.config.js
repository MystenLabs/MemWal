/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ['@mysten/walrus', '@mysten/walrus-wasm'],
  },
  generateBuildId: async () => {
    return 'build-' + Date.now();
  },
  env: {
    NEXT_PUBLIC_GEMINI_API_KEY: process.env.NEXT_PUBLIC_GEMINI_API_KEY,
    NEXT_PUBLIC_PACKAGE_ID: process.env.NEXT_PUBLIC_PACKAGE_ID,
    NEXT_PUBLIC_ACCESS_REGISTRY_ID: process.env.NEXT_PUBLIC_ACCESS_REGISTRY_ID,
    NEXT_PUBLIC_WALLET_REGISTRY_ID: process.env.NEXT_PUBLIC_WALLET_REGISTRY_ID,
    NEXT_PUBLIC_WALRUS_PUBLISHER: process.env.NEXT_PUBLIC_WALRUS_PUBLISHER,
    NEXT_PUBLIC_WALRUS_AGGREGATOR: process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR,
  },
  webpack: (config, { isServer }) => {
    config.externals.push('pino-pretty', 'encoding');

    // Ensure @tanstack/react-query resolves to the app's node_modules
    config.resolve.alias = {
      ...config.resolve.alias,
      '@tanstack/react-query': require.resolve('@tanstack/react-query'),
    };

    // Exclude Node.js native modules from client bundle
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        os: false,
        crypto: false,
        stream: false,
        buffer: false,
        assert: false,
        http: false,
        https: false,
        zlib: false,
        util: false,
      };

      // Ignore Node.js-only modules for client-side
      config.externals.push('hnswlib-node', 'undici');
    }

    return config;
  },
};

module.exports = nextConfig;
