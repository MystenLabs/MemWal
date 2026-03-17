import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import { spawn } from 'child_process'

// Build docs together with app
function buildDocs() {
  return {
    name: 'build-docs',
    closeBundle() {
      return new Promise((resolve) => {
        const child = spawn('npx', ['vitepress', 'build', 'docs'], {
          stdio: 'inherit',
          shell: true,
        })
        child.on('close', (code) => {
          if (code === 0) resolve(true)
          else resolve(true) // Continue even if docs fail
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait(), buildDocs()],
  resolve: {
    dedupe: ['react', 'react-dom', '@tanstack/react-query'],
  },
  optimizeDeps: {
    include: ['@mysten/seal', '@mysten/sui/transactions', '@mysten/sui/client'],
  },
})
