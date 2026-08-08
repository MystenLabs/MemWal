/**
 * Manual-testing helper: starts the app dev server on :5173 with the
 * exact same devstack env the Playwright suite uses, for manual testing.
 * Usage: pnpm exec tsx e2e/manualDevServer.ts
 */
import { spawn } from 'node:child_process'

import { loadDevstackEnv } from './support/devstackEnv.ts'

const devstack = loadDevstackEnv()

// `devstack.rpcUrl` comes from deployment.json, which on a proxied devstack is a
// SUBDOMAIN of localhost (e.g. rpc.<stack>.<app>.localhost:9000). The dev wallet's
// `local-json-rpc` transport requires a literal loopback host
// (support/devWalletEntry.ts) and throws on anything else, so this helper is unusable
// out of the box on that topology. MANUAL_SUI_RPC_URL points it at the node directly
// (e.g. http://127.0.0.1:9000); keep it in step with e2e/manualBrowser.ts.
const rpcUrl = process.env.MANUAL_SUI_RPC_URL || devstack.rpcUrl

const child = spawn('pnpm', ['dev', '--', '--port', '5173', '--strictPort'], {
	stdio: 'inherit',
	env: {
		...process.env,
		VITE_ENABLE_MEMORY_DELETION: 'true',
		VITE_SECURITY_DELETE_ENABLED: 'true',
		VITE_MEMWAL_SERVER_URL: devstack.serverUrl,
		VITE_SUI_NETWORK: 'testnet',
		VITE_SUI_RPC_URL: rpcUrl,
		VITE_SUI_LOCAL_E2E_JSON_RPC: 'true',
		VITE_MEMWAL_PACKAGE_ID: devstack.memwalPackageId,
		VITE_MEMWAL_REGISTRY_ID: devstack.memwalRegistryId,
		VITE_SEAL_KEY_SERVERS: devstack.sealKeyServerObjectId,
		VITE_WALRUS_AGGREGATOR_URL: devstack.walrusAggregatorUrl,
		VITE_WALRUS_SYSTEM_OBJECT_ID: devstack.walrusSystemObjectId,
		VITE_WALRUS_STAKING_POOL_ID: devstack.walrusStakingPoolId,
	},
})

child.on('exit', (code) => process.exit(code ?? 0))
