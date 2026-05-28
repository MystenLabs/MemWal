import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

const memwalRelayerTarget = process.env.VITE_MEMWAL_RELAYER_PROXY_TARGET || 'https://relayer.memwal.ai'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api/memwal': {
        target: memwalRelayerTarget,
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/memwal/, ''),
      },
    },
  },
  resolve: {
    dedupe: ['react', 'react-dom', '@tanstack/react-query'],
  },
  optimizeDeps: {
    include: ['@mysten/seal', '@mysten/sui/transactions', '@mysten/sui/client'],
  },
})
