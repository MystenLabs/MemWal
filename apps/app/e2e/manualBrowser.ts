/**
 * Manual-testing helper: opens a HEADED Chromium at the local
 * dashboard with the e2e dev wallet ("MemWal E2E Dev Wallet", user1's
 * devstack account) injected on every page load — exactly the same
 * injection the Playwright suite uses, so wallet connect/sign popups
 * auto-approve. Close the browser window to end the session.
 * Usage: pnpm exec tsx e2e/manualBrowser.ts
 */
import { chromium } from '@playwright/test'

import { buildDevWalletBundle } from './support/buildDevWalletBundle.ts'
import { loadDevstackEnv } from './support/devstackEnv.ts'

const devstack = loadDevstackEnv()
const bundlePath = await buildDevWalletBundle()

const browser = await chromium.launch({
	headless: false,
	executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
})
const context = await browser.newContext({ viewport: null })

// Override to drive a different owner (e.g. a load-cohort wallet):
// MANUAL_WALLET_SUIPRIVKEY=suiprivkey1... pnpm exec tsx e2e/manualBrowser.ts
//
// `devstack.rpcUrl` comes from deployment.json, which on a proxied devstack is a
// SUBDOMAIN of localhost (e.g. rpc.<stack>.<app>.localhost:9000). The
// `local-json-rpc` wallet transport requires a literal loopback host
// (support/devWalletEntry.ts) and throws on anything else, so this helper is
// unusable out of the box on that topology. MANUAL_SUI_RPC_URL points it at the
// node directly (e.g. http://127.0.0.1:9000).
const walletConfig = {
	suiPrivateKey: process.env.MANUAL_WALLET_SUIPRIVKEY || devstack.ownerSuiPrivateKey,
	endpoint: process.env.MANUAL_SUI_RPC_URL || devstack.rpcUrl,
	transport: 'local-json-rpc' as const,
	network: 'localnet',
}
await context.addInitScript((cfg) => {
	;(window as unknown as { __E2E_WALLET_CONFIG__: typeof cfg }).__E2E_WALLET_CONFIG__ = cfg
}, walletConfig)
await context.addInitScript({ path: bundlePath })

const page = await context.newPage()
await page.goto('http://localhost:5173/')

console.log(`[manual] dashboard open at http://localhost:5173/ — wallet: ${devstack.ownerAddress}`)
console.log('[manual] close the browser window to end the session')

await new Promise<void>((resolveDone) => {
	context.on('close', () => resolveDone())
	browser.on('disconnected', () => resolveDone())
})
process.exit(0)
