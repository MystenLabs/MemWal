/**
 * Bundles `devWalletEntry.ts` (which has real npm imports — `@mysten-incubation/dev-wallet`,
 * `@mysten/sui/*`) into a single dependency-free IIFE, since
 * `page.addInitScript({ path })` injects raw script content into the page —
 * the browser can't resolve bare module specifiers itself. Reuses `vite`
 * (already a devDependency for the app itself) rather than adding a
 * separate bundler dependency just for this.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'vite'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Builds the injector once per Playwright run and returns the emitted
 *  file's absolute path. Caches the promise (not just the path) so
 *  concurrent callers within one process share a single build. */
let cached: Promise<string> | undefined

export function buildDevWalletBundle(): Promise<string> {
	cached ??= buildOnce()
	return cached
}

async function buildOnce(): Promise<string> {
	const outDir = mkdtempSync(join(tmpdir(), 'memwal-e2e-dev-wallet-'))
	await build({
		configFile: false,
		logLevel: 'warn',
		build: {
			outDir,
			emptyOutDir: true,
			minify: false,
			target: 'es2020',
			lib: {
				entry: resolve(HERE, 'devWalletEntry.ts'),
				name: 'memwalE2EDevWallet',
				formats: ['iife'],
				fileName: () => 'dev-wallet-entry.js',
			},
			// Wallet-standard registration must happen before the app's own
			// `getWallets()` call reads the registry — the whole point of an
			// init script — so this can't be a `<script type="module">`
			// loaded asynchronously; the IIFE format above already inlines
			// every import, this just silences vite's "no exports" warning
			// for a build with no rollupOptions.output.exports use case.
			rollupOptions: { output: { inlineDynamicImports: true } },
		},
	})
	return resolve(outDir, 'dev-wallet-entry.js')
}
