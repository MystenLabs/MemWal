/**
 * Resolves the live security-delete-loadtest-e2e devstack's connection
 * details for this Playwright suite — read directly from that package's
 * `.env.stack` (written by its `stack.sh`) and its devstack `deployment.json`
 * rather than imported as a JS module: `security-delete-loadtest-e2e` has no
 * build output / package `exports` (it's a `tsx`-run CLI harness, see its
 * package.json), and Playwright's test runner does not transpile arbitrary
 * `.ts` files reached through `node_modules`/workspace imports the way its
 * own `testDir` files are transpiled. Shelling out to its CLI scripts
 * (global-setup.ts) and duplicating this tiny bit of file-reading here is
 * more robust than fighting that boundary — see the runbook's Playwright
 * section for the full rationale.
 *
 * These ids are specific to whichever devstack is currently booted (they
 * change on every `devstack:up` if the stack was wiped) — never hardcode
 * them; always resolve fresh from disk, exactly like `stack.sh` and
 * `tests/security-delete-loadtest-e2e/src/config.ts` do.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const LOADTEST_PACKAGE_ROOT = resolve(HERE, '../../../../tests/security-delete-loadtest-e2e')

/** Devstack account this whole e2e suite targets — see
 *  `tests/security-delete-loadtest-e2e/src/frontend-fixture.ts`'s module doc
 *  for why `user1` specifically (not user0/2/3) is safe to reuse here. */
export const FRONTEND_FIXTURE_WALLET_NAME = 'user1'

/** Must match `FRONTEND_FIXTURE_TEXTS` in
 *  `tests/security-delete-loadtest-e2e/src/frontend-fixture.ts` exactly —
 *  duplicated (not imported, see module doc above) since that's the known
 *  plaintext the Seal preview assertion checks for. */
export const FRONTEND_FIXTURE_TEXTS = [
	'security-delete e2e fixture memory one — do not modify or reuse this string',
	'security-delete e2e fixture memory two — do not modify or reuse this string',
	'security-delete e2e fixture memory three — do not modify or reuse this string',
] as const

function parseEnvFile(path: string): Record<string, string> {
	const out: Record<string, string> = {}
	const text = readFileSync(path, 'utf8')
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim()
		if (line.length === 0 || line.startsWith('#')) continue
		const eq = line.indexOf('=')
		if (eq === -1) continue
		const key = line.slice(0, eq).trim()
		let value = line.slice(eq + 1).trim()
		if (
			(value.startsWith("'") && value.endsWith("'")) ||
			(value.startsWith('"') && value.endsWith('"'))
		) {
			value = value.slice(1, -1)
		}
		out[key] = value
	}
	return out
}

function findStackDir(): string {
	const stacksDir = resolve(LOADTEST_PACKAGE_ROOT, '.devstack/stacks')
	const entries = readdirSync(stacksDir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
	if (entries.length === 0) {
		throw new Error(`${stacksDir} has no stack directories — is devstack up?`)
	}
	return resolve(stacksDir, entries[0])
}

export interface DevstackEnv {
	/** Sui JSON-RPC endpoint (router hostname — JSON-RPC works fine through
	 *  it, only gRPC doesn't; see the runbook's "gRPC vs JSON-RPC" section). */
	rpcUrl: string
	memwalPackageId: string
	memwalRegistryId: string
	/** Aggregator base URL — see utils/blobPreview.ts's module doc for why
	 *  the preview's blob read goes through this instead of a direct
	 *  WalrusClient.readBlob() quorum read against devstack. */
	walrusAggregatorUrl: string
	/** Devstack's Walrus package config — WalrusClient only resolves these
	 *  itself for "mainnet"/"testnet", so the app's preview-time blob id
	 *  check (blobPreview.ts's computeBlobMetadata call) needs them supplied
	 *  directly, exactly like the sidecar's createWalrusClient does. */
	walrusSystemObjectId: string
	walrusStakingPoolId: string
	/** The devstack's single local-keygen Seal key server's on-chain
	 *  KeyServer object id. */
	sealKeyServerObjectId: string
	serverUrl: string
	/** `user1`'s address — must match what
	 *  `tests/security-delete-loadtest-e2e/src/frontend-fixture.ts` seeded. */
	ownerAddress: string
	/** `user1`'s bech32 `suiprivkey1...` — a devstack-generated, funded
	 *  THROWAWAY test account with zero real-world value, never a production
	 *  secret. Used to drive the injected dev-wallet's real signatures. */
	ownerSuiPrivateKey: string
}

let cached: DevstackEnv | undefined

export function loadDevstackEnv(): DevstackEnv {
	if (cached) return cached

	const envStackPath = resolve(LOADTEST_PACKAGE_ROOT, '.env.stack')
	const env = parseEnvFile(envStackPath)
	const require = <K extends string>(key: K): string => {
		const value = env[key]
		if (!value) throw new Error(`${key} missing from ${envStackPath} — run stack.sh first`)
		return value
	}

	const sealServerConfigs = JSON.parse(require('SEAL_SERVER_CONFIGS')) as { objectId: string }[]
	if (sealServerConfigs.length === 0) {
		throw new Error(`SEAL_SERVER_CONFIGS in ${envStackPath} has no entries`)
	}

	const stackDir = findStackDir()
	const deployment = JSON.parse(readFileSync(resolve(stackDir, 'deployment.json'), 'utf8')) as {
		defaultNetwork: string
		networks: Record<string, { rpc: string }>
	}
	const rpcUrl = deployment.networks[deployment.defaultNetwork]?.rpc
	if (!rpcUrl) throw new Error(`deployment.json has no rpc for network ${deployment.defaultNetwork}`)

	const ownerAddress = readAccountAddress(stackDir)
	const ownerSuiPrivateKey = readFileSync(
		resolve(stackDir, 'account', `${FRONTEND_FIXTURE_WALLET_NAME}.key`),
		'utf8',
	).trim()

	cached = {
		rpcUrl,
		memwalPackageId: require('MEMWAL_PACKAGE_ID'),
		memwalRegistryId: require('MEMWAL_REGISTRY_ID'),
		walrusAggregatorUrl: require('WALRUS_AGGREGATOR_URL'),
		walrusSystemObjectId: require('WALRUS_SYSTEM_OBJECT_ID'),
		walrusStakingPoolId: require('WALRUS_STAKING_POOL_ID'),
		sealKeyServerObjectId: sealServerConfigs[0].objectId,
		serverUrl: 'http://localhost:8000',
		ownerAddress,
		ownerSuiPrivateKey,
	}
	return cached
}

/** `.env.stack` has no per-account address map — only `deployment.json`'s
 *  top-level `accounts` field does (mirrors what `wallets.ts` reads on the
 *  loadtest side, minus the address's own devstack codegen module). */
function readAccountAddress(stackDir: string): string {
	const deployment = JSON.parse(readFileSync(resolve(stackDir, 'deployment.json'), 'utf8')) as {
		accounts: Record<string, string>
	}
	const address = deployment.accounts[FRONTEND_FIXTURE_WALLET_NAME]
	if (!address) {
		throw new Error(`deployment.json has no account "${FRONTEND_FIXTURE_WALLET_NAME}"`)
	}
	return address
}
