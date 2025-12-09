/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  experimental: {
    serverComponentsExternalPackages: ['personal-data-wallet-sdk', '@mysten/walrus', 'hnswlib-wasm'],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Externalize problematic packages
      config.externals = config.externals || []
      if (Array.isArray(config.externals)) {
        config.externals.push({
          'hnswlib-wasm': 'commonjs hnswlib-wasm',
          '@mysten/walrus': 'commonjs @mysten/walrus',
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
      ]
    }
    
    return config
  },
}

export default nextConfig
