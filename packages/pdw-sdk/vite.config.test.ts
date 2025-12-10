import { defineConfig } from 'vite';
import { resolve } from 'path';

/**
 * Vite config for building browser-compatible SDK bundle for E2E tests.
 *
 * This bundles the SDK with all dependencies for use in browser tests.
 * Note: Some dependencies may need to be externalized if they don't support browser.
 */
export default defineConfig({
  build: {
    lib: {
      // Use browser entry point that excludes React hooks
      entry: resolve(__dirname, 'src/browser.ts'),
      name: 'PDW',
      fileName: 'pdw-sdk.browser',
      formats: ['es'],
    },
    outDir: 'dist-browser',
    rollupOptions: {
      // Externalize Sui packages - loaded via esm.sh CDN in test page
      external: [
        '@mysten/sui',
        '@mysten/sui/client',
        '@mysten/sui/keypairs/ed25519',
        '@mysten/sui/cryptography',
        '@mysten/sui/transactions',
        '@mysten/sui/utils',
        '@mysten/sui/verify',
        '@mysten/sui/bcs',
        '@mysten/dapp-kit',
        // React is NOT in browser entry, but keep it here just in case
        'react',
        'react-dom',
        '@tanstack/react-query',
      ],
      output: {
        globals: {
          '@mysten/sui': 'Sui',
        },
      },
    },
    // Don't minify for easier debugging
    minify: false,
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  // Define Node.js globals for browser compatibility
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env': JSON.stringify({}),
    'process': JSON.stringify({ env: { NODE_ENV: 'production' } }),
  },
});
