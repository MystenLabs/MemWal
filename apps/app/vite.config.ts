import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

// TEMPORARY LOCAL PATCH (not for upstream): the real dev backend's CORS
// allowlist (ALLOWED_ORIGINS) has no localhost entry, so the memwal SDK's
// direct browser calls to relayer.dev.memwal.ai (/health, /version, /api/*,
// /sponsor) are blocked. Proxy them server-side through Vite's dev server —
// no path rewrite, so signed-request signatures (which sign method+path+body,
// not host) stay valid.
const DEV_BACKEND = 'https://relayer.dev.memwal.ai'
const proxyConfig = {
  changeOrigin: true,
  secure: true,
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  resolve: {
    dedupe: ['react', 'react-dom', '@tanstack/react-query'],
  },
  optimizeDeps: {
    include: ['@mysten/seal', '@mysten/sui/transactions', '@mysten/sui/client'],
  },
  server: {
    proxy: {
      '/api': { target: DEV_BACKEND, ...proxyConfig },
      '/health': { target: DEV_BACKEND, ...proxyConfig },
      '/version': { target: DEV_BACKEND, ...proxyConfig },
      '/config': { target: DEV_BACKEND, ...proxyConfig },
      '/sponsor': { target: DEV_BACKEND, ...proxyConfig },
    },
  },
})
