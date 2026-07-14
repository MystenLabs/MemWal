import { defineConfig, devices } from '@playwright/test'

import { loadDevstackEnv } from './e2e/support/devstackEnv.ts'

// Resolved synchronously at config-load time (before the webServer spawns)
// from the live security-delete-loadtest-e2e devstack — see devstackEnv.ts's
// module doc for why these ids are never hardcoded. Throws with a clear
// message if the stack isn't up, which is exactly what should happen: this
// suite has nothing to test against without it (see the loadtest package's
// README "Playwright" section for the bring-up runbook).
const devstack = loadDevstackEnv()

const PORT = 5173
const baseURL = `http://localhost:${PORT}`
const isCI = !!process.env.CI

export default defineConfig({
	testDir: './e2e',
	testMatch: /.*\.spec\.ts$/,
	outputDir: './e2e/.results',
	fullyParallel: false,
	forbidOnly: isCI,
	retries: isCI ? 1 : 0,
	// One worker: the suite drives one shared devstack wallet/account and
	// asserts exact popup counts + exact row counts against real chain/DB
	// state — parallel workers would race the same rows.
	workers: 1,
	reporter: isCI ? [['github'], ['list']] : [['list']],

	use: {
		baseURL,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		actionTimeout: 15_000,
		navigationTimeout: 30_000,
		// Normally unset — Playwright resolves its own managed, version-pinned
		// Chromium (`playwright install chromium`). Escape hatch for
		// environments whose egress can't reach Playwright's CDN to fetch the
		// exact pinned revision (this repo's sandbox is one — see the
		// runbook's Playwright section); point it at any already-present
		// Chromium/chrome-headless-shell binary instead.
		launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
			? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
			: undefined,
	},

	// Real Seal decrypt (browser-side WASM) + real Walrus storage-node reads
	// + real chain reads/writes against devstack are slower than a mocked
	// suite; generous but bounded.
	timeout: 90_000,
	expect: { timeout: 15_000 },

	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],

	webServer: {
		command: 'pnpm dev -- --port 5173 --strictPort',
		url: baseURL,
		timeout: 60_000,
		reuseExistingServer: !isCI,
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			VITE_ENABLE_MEMORY_DELETION: 'true',
			VITE_SECURITY_DELETE_ENABLED: 'true',
			VITE_MEMWAL_SERVER_URL: devstack.serverUrl,
			// Select the localnet-only JSON-RPC escape hatch (the app maps it
			// to a distinct localnet dapp-kit identity) and override its RPC/package/registry/
			// Walrus/Seal ids to point at the live devstack.
			VITE_SUI_NETWORK: 'testnet',
			VITE_SUI_RPC_URL: devstack.rpcUrl,
			VITE_SUI_LOCAL_E2E_JSON_RPC: 'true',
			VITE_MEMWAL_PACKAGE_ID: devstack.memwalPackageId,
			VITE_MEMWAL_REGISTRY_ID: devstack.memwalRegistryId,
			VITE_SEAL_KEY_SERVERS: devstack.sealKeyServerObjectId,
			VITE_WALRUS_AGGREGATOR_URL: devstack.walrusAggregatorUrl,
			VITE_WALRUS_SYSTEM_OBJECT_ID: devstack.walrusSystemObjectId,
			VITE_WALRUS_STAKING_POOL_ID: devstack.walrusStakingPoolId,
		},
	},
})
