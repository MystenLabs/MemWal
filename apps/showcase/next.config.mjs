/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    // Build errors are now checked - fix TypeScript errors instead of ignoring them
    ignoreBuildErrors: false,
  },
  images: {
    unoptimized: true,
  },
  experimental: {
    // External packages that should not be bundled by webpack
    // hnswlib-node requires native bindings and must be loaded directly by Node.js
    serverComponentsExternalPackages: [
      '@cmdoss/memwal-sdk',
      '@mysten/walrus',
      'hnswlib-wasm',
      'hnswlib-node',  // Native Node.js module for HNSW
    ],
  },
  webpack: (config, { isServer }) => {
    // Client-side: Provide empty modules for Node.js APIs
    // This fixes "Module not found: Can't resolve 'fs'" errors from SDK
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        'fs/promises': false,
        path: false,
        crypto: false,
      }
    }

    if (isServer) {
      // Externalize problematic packages (native modules, WASM)
      config.externals = config.externals || []
      if (Array.isArray(config.externals)) {
        config.externals.push({
          'hnswlib-wasm': 'commonjs hnswlib-wasm',
          '@mysten/walrus': 'commonjs @mysten/walrus',
          'hnswlib-node': 'commonjs hnswlib-node',  // Native Node.js module
        })
      }

      // Handle WASM files
      config.experiments = {
        ...config.experiments,
        asyncWebAssembly: true,
        layers: true,
      }

      // Add rule for .wasm files
      config.module.rules.push({
        test: /\.wasm$/,
        type: 'asset/resource',
      })

      // Ignore dynamic require warnings
      config.ignoreWarnings = [
        { module: /node_modules\/hnswlib-wasm/ },
        { module: /node_modules\/@mysten\/walrus/ },
        { module: /node_modules\/hnswlib-node/ },
      ]
    }

    return config
  },
}

export default nextConfig
