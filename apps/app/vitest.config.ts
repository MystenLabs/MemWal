import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default defineConfig(async (env) => mergeConfig(
    await viteConfig({ ...env, command: 'serve', isSsrBuild: false, isPreview: false }),
    defineConfig({ test: {
        environment: 'jsdom',
        setupFiles: ['./src/test/setup.ts'],
        globals: true,
        // e2e/ is Playwright's testDir (`pnpm test:e2e`), not a vitest suite.
        exclude: [...configDefaults.exclude, 'e2e/**'],
    } }),
))
