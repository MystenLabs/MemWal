import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  // Opt-in dev-server proxy (set DEV_BACKEND_PROXY_TARGET, e.g. in
  // .env.local — not VITE_-prefixed, this is Node-side vite.config.ts only,
  // never bundled into client code). Needed when the target backend's CORS
  // allowlist has no localhost entry, so the memwal SDK's direct browser
  // calls (/health, /version, /api/*, /sponsor) would otherwise be blocked.
  // No path rewrite, so signed-request signatures (which sign method+path+
  // body, not host) stay valid. Unset by default — no proxy configured.
  const proxyTarget = env.DEV_BACKEND_PROXY_TARGET
  const proxyConfig = { changeOrigin: true, secure: true }
  const proxy = proxyTarget
    ? {
        '/api': { target: proxyTarget, ...proxyConfig },
        '/health': { target: proxyTarget, ...proxyConfig },
        '/version': { target: proxyTarget, ...proxyConfig },
        '/config': { target: proxyTarget, ...proxyConfig },
        '/sponsor': { target: proxyTarget, ...proxyConfig },
      }
    : undefined

  return {
    plugins: [react(), wasm(), topLevelAwait()],
    resolve: {
      dedupe: ['react', 'react-dom', '@tanstack/react-query'],
    },
    optimizeDeps: {
      include: ['@mysten/seal', '@mysten/sui/transactions', '@mysten/sui/client'],
    },
    server: {
      proxy,
    },
  }
})
