/**
 * Browser-side entry point, bundled to a single IIFE (see
 * `buildDevWalletBundle.ts`) and injected via `page.addInitScript` BEFORE
 * the app's own scripts run on every navigation — this is what makes the
 * app's `@mysten/dapp-kit` `WalletProvider` (no `wallets` prop — see
 * `App.tsx`, standard wallet-standard auto-discovery) find and auto-connect
 * a real signer for `user1`'s devstack address without any human click.
 *
 * Reads its config off `window.__E2E_WALLET_CONFIG__`, set by a plain
 * (unbundled) `page.addInitScript` call in the spec *before* this bundle's
 * init script — see securityDelete.spec.ts.
 *
 * Popup-count contract (spec §10): rather than intercepting DevWallet's UI
 * approval flow, this uses `autoApprove` as a per-request counting hook —
 * DevWallet calls it once per signing request, before executing it, with
 * exactly the `{type, account, chain}` shape the wallet's own request queue
 * would show a human. Counting here is equivalent to "would have shown a
 * popup", the same thing a real click-through UI count would measure.
 */
import { DevWallet } from '@mysten-incubation/dev-wallet'
import { InMemorySignerAdapter } from '@mysten-incubation/dev-wallet/adapters'
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc'

export interface E2EWalletConfig {
	suiPrivateKey: string
	endpoint: string
	/** Real testnet uses gRPC. JSON-RPC is restricted to the local devstack
	 * browser suite, whose router does not expose gRPC-web. */
	transport: 'grpc' | 'local-json-rpc'
	/** Must match the app's effective dapp-kit `suiClientNetwork`: localnet
	 *  for the local JSON suite, testnet for the real gRPC dashboard. Dapp Kit
	 *  matches wallets by their advertised `sui:<name>` chain id. */
	network: string
}

export interface E2EWalletCall {
	type: 'sign-transaction' | 'sign-and-execute-transaction' | 'sign-personal-message'
	at: number
}

declare global {
	interface Window {
		__E2E_WALLET_CONFIG__?: E2EWalletConfig
		__E2E_WALLET_CALLS__?: E2EWalletCall[]
		__E2E_WALLET_READY__?: Promise<void>
	}
}

/**
 * Registers a wallet with the app's wallet-standard registry via the
 * cross-bundle window-event protocol, NOT `DevWallet.register()` (which
 * calls the app-side `getWallets().register()` API). This script is bundled
 * to its own standalone IIFE (see buildDevWalletBundle.ts) and injected via
 * `page.addInitScript` — it gets its OWN module-level singleton of
 * `@wallet-standard/app`, entirely separate from the one the app's Vite
 * bundle instantiates. `wallet.register()` only updates THIS bundle's
 * private registry, which the app never observes, so dApp Kit's wallet
 * picker silently omits the wallet (discovered by seeing it register with
 * zero effect on the "Connect a Wallet" list — see debugging notes in
 * securityDelete.spec.ts's PR). The window-event protocol is exactly how
 * cross-realm wallets (browser extensions, and dev-wallet's own
 * `src/app/bookmarklet-entry.ts` injected-script mode) bridge this gap: the
 * app's `getWallets()` call already listens for `wallet-standard:register-wallet`,
 * and — in case it initializes after this script runs — this also listens
 * for the app's `wallet-standard:app-ready` announcement.
 */
function registerWalletViaEvent(wallet: DevWallet): void {
	const callback = ({ register }: { register: (...wallets: DevWallet[]) => void }) => register(wallet)
	try {
		window.dispatchEvent(
			new CustomEvent('wallet-standard:register-wallet', {
				bubbles: false,
				cancelable: false,
				composed: false,
				detail: callback,
			}),
		)
	} catch (error) {
		console.error('wallet-standard:register-wallet event could not be dispatched\n', error)
	}
	try {
		window.addEventListener('wallet-standard:app-ready', ((event: CustomEvent) =>
			callback(event.detail)) as EventListener)
	} catch (error) {
		console.error('wallet-standard:app-ready event listener could not be added\n', error)
	}
}

async function registerDevWallet(): Promise<void> {
	const cfg = window.__E2E_WALLET_CONFIG__
	if (!cfg) {
		console.warn('[e2e] __E2E_WALLET_CONFIG__ not set — dev wallet not registered')
		return
	}
	window.__E2E_WALLET_CALLS__ = []

	const { secretKey } = decodeSuiPrivateKey(cfg.suiPrivateKey)
	const keypair = Ed25519Keypair.fromSecretKey(secretKey)
	let clientFactory: (network: string, url: string) => SuiGrpcClient | SuiJsonRpcClient
	if (cfg.transport === 'grpc') {
		clientFactory = (network, url) => new SuiGrpcClient({ network, baseUrl: url })
	} else if (cfg.transport === 'local-json-rpc') {
		const hostname = new URL(cfg.endpoint).hostname
		if (cfg.network !== 'localnet' || !['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
			throw new Error('local-json-rpc wallet transport requires localnet and a loopback endpoint')
		}
		clientFactory = (network, url) => new SuiJsonRpcClient({ network, url })
	} else {
		throw new Error(`unsupported E2E wallet transport: ${String(cfg.transport)}`)
	}

	const adapter = new InMemorySignerAdapter()
	await adapter.initialize()
	await adapter.importAccount({ signer: keypair, label: 'e2e-owner' })

	const wallet = new DevWallet({
		adapters: [adapter],
		networks: { [cfg.network]: cfg.endpoint },
		activeNetwork: cfg.network,
		autoConnect: true,
		name: 'MemWal E2E Dev Wallet',
		clientFactory: clientFactory as never,
		autoApprove: (request) => {
			window.__E2E_WALLET_CALLS__!.push({ type: request.type, at: Date.now() })
			return true
		},
	})
	registerWalletViaEvent(wallet)
}

window.__E2E_WALLET_READY__ = registerDevWallet()
