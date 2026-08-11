/**
 * Browser e2e for the security-delete dashboard flow (SDD task 9) — the one
 * thing the vitest component tests (SecurityDeleteSection.test.tsx,
 * useSecurityDeletion.test.ts, blobPreview.test.ts) can't cover: a real
 * browser driving wallet auth -> table -> Seal preview decrypt -> delete ->
 * progress, against the live devstack stack (real chain, real Walrus, real
 * Seal key server, real server/sidecar — no mocked API responses).
 *
 * Runs against 3 real, Seal-encrypted memories seeded for one devstack
 * wallet (`user1`) via the production remember flow — see
 * `tests/security-delete-loadtest-e2e/src/frontend-fixture.ts`'s module doc
 * for why that wallet specifically, and why publisher-path (synthetic)
 * blobs can't stand in here (their payload isn't genuinely Seal-decryptable).
 * `beforeAll` seeds idempotently: a second run against already-seeded state
 * submits zero new remember jobs and zero new legacy rows.
 *
 * The injected "wallet" is `@mysten-incubation/dev-wallet` wired to the
 * seeded owner's real devstack private key (see support/devWalletEntry.ts) —
 * it produces genuine Ed25519 signatures over genuine challenge/session/tx
 * bytes, just without a human click. dApp Kit auto-discovers it via the
 * standard wallet-standard registry (App.tsx's `WalletProvider` has no
 * `wallets` prop) exactly as it would a browser extension.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { expect, test } from '@playwright/test'

import { buildDevWalletBundle } from './support/buildDevWalletBundle'
import { FRONTEND_FIXTURE_TEXTS, LOADTEST_PACKAGE_ROOT, loadDevstackEnv } from './support/devstackEnv'
import type { E2EWalletCall, E2EWalletConfig } from './support/devWalletEntry'

const devstack = loadDevstackEnv()
const FIXTURE_CHECKPOINT = resolve(LOADTEST_PACKAGE_ROOT, '.frontend-fixture.seed.json')

let seededBlobIds: string[]
let devWalletBundlePath: string

test.beforeAll(async () => {
	// Idempotent — see frontend-fixture.ts. Runs the real remember flow
	// (server -> sidecar -> Seal encrypt -> Walrus upload -> metadata tx),
	// the legacy-DB old-V1-writer emulation, and waits for the background
	// object-id resolver, so by the time the browser suite starts every row
	// is already `deletable` with a resolved `object_id`.
	const seedResult = spawnSync(
		'pnpm',
		['exec', 'tsx', 'src/frontend-fixture.ts', '--checkpoint', FIXTURE_CHECKPOINT],
		{ cwd: LOADTEST_PACKAGE_ROOT, stdio: 'inherit' },
	)
	if (seedResult.status !== 0) {
		throw new Error(`frontend-fixture.ts exited with status ${seedResult.status}`)
	}

	const checkpoint = JSON.parse(readFileSync(FIXTURE_CHECKPOINT, 'utf8')) as {
		wallets: { address: string; blobIds: string[] }[]
	}
	const walletEntry = checkpoint.wallets.find(
		(w) => w.address.toLowerCase() === devstack.ownerAddress.toLowerCase(),
	)
	if (!walletEntry || walletEntry.blobIds.length !== FRONTEND_FIXTURE_TEXTS.length) {
		throw new Error(
			`expected ${FRONTEND_FIXTURE_TEXTS.length} seeded blobs for ${devstack.ownerAddress} in ` +
				`${FIXTURE_CHECKPOINT}, found ${walletEntry?.blobIds.length ?? 0}`,
		)
	}
	seededBlobIds = walletEntry.blobIds

	devWalletBundlePath = await buildDevWalletBundle()
})

test.beforeEach(async ({ page }) => {
	// Two init scripts, in order: (1) a plain function — no bundling needed,
	// it only touches `window` — that stashes the wallet's config where the
	// bundle below reads it; (2) the bundled dev-wallet, which registers a
	// real wallet-standard wallet for that account before the app's own
	// scripts (and its `getWallets()` discovery call) ever run.
	const walletConfig: E2EWalletConfig = {
		suiPrivateKey: devstack.ownerSuiPrivateKey,
		endpoint: devstack.rpcUrl,
		transport: 'local-json-rpc',
		network: 'localnet',
	}
	await page.addInitScript((cfg) => {
		;(window as unknown as { __E2E_WALLET_CONFIG__: typeof cfg }).__E2E_WALLET_CONFIG__ = cfg
	}, walletConfig)
	await page.addInitScript({ path: devWalletBundlePath })
})

async function walletCalls(page: import('@playwright/test').Page): Promise<E2EWalletCall[]> {
	return page.evaluate(
		() => (window as unknown as { __E2E_WALLET_CALLS__?: E2EWalletCall[] }).__E2E_WALLET_CALLS__ ?? [],
	)
}

test('security delete: connect, table, Seal preview, delete selected, progress, popup-count contract', async ({
	page,
}) => {
	// Hard assertion (not a log line): capture every request's raw POST body
	// for the whole test and assert afterward that none of the 3 known
	// plaintexts — nor the wallet's private key material — ever appeared in
	// one. Attached before any navigation so nothing is missed.
	const requestBodies: string[] = []
	page.on('request', (req) => {
		const body = req.postData()
		if (body) requestBodies.push(body)
	})

	// 1. Connect the injected wallet from the landing page (App.tsx's
	// `requireAccount` route guard redirects `/dashboard` -> `/` without a
	// connected account, so this is also where the flow must start).
	await page.goto('/')
	await page.getByRole('button', { name: 'Connect wallet' }).click()
	await page.getByRole('button', { name: 'MemWal E2E Dev Wallet' }).click()
	await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 })

	// 2. Loading the list requires explicit user intent before the wallet auth
	// challenge. The "Stored" tab then lists all 3 seeded rows.
	await page.locator('#cleanup').scrollIntoViewIfNeeded()
	await expect(await walletCalls(page)).toHaveLength(0)
	await page.getByRole('button', { name: 'Load my memories' }).click()
	const atRiskTab = page.getByRole('tab', { name: 'Stored' })
	await expect(atRiskTab).toHaveAttribute('aria-selected', 'true')

	for (const blobId of seededBlobIds) {
		const row = page.locator('tr', { has: page.getByTitle(blobId, { exact: true }) })
		await expect(row).toBeVisible({ timeout: 20_000 })
		// objectId resolved by the background resolver in beforeAll — never
		// the "resolving…" placeholder — and createdAt renders a real date.
		await expect(row.getByText('resolving…')).toHaveCount(0)
		await expect(row.locator('td').nth(3)).not.toHaveText('')
	}

	// Counts are asserted as exact deltas from a captured baseline, not
	// absolutes: `user1`'s account accumulates fixture rows across runs by
	// design (each run seeds 3, deletes 2 — deleted rows are terminal), so
	// absolute counts would only pass on a virgin stack. The delta is still
	// a hard exact-value assertion; see step 5.
	const countsLine = page.locator('.sd-counts')
	await expect(countsLine).toHaveText(/\d+ stored, \d+ in progress, \d+ deleted/)
	const parseCounts = (text: string) => {
		const match = text.match(/(\d+)\s+stored,\s+(\d+)\s+in progress,\s+(\d+)\s+deleted/)
		if (!match) throw new Error(`unexpected counts line: ${text}`)
		return { atRisk: Number(match[1]), inProgress: Number(match[2]), deleted: Number(match[3]) }
	}
	const countsBefore = parseCounts((await countsLine.textContent()) ?? '')
	expect(countsBefore.atRisk).toBeGreaterThanOrEqual(seededBlobIds.length)

	// 3. Preview the first row: real in-browser Seal decrypt of the exact
	// seeded plaintext, via a genuine Seal session-key signature (2nd wallet
	// popup) that fetches ciphertext from Walrus + decryption keys from the
	// devstack Seal key server — nothing mocked.
	await page.getByRole('button', { name: `Preview ${seededBlobIds[0]}` }).click()
	const previewDialog = page.getByRole('dialog', { name: 'Memory preview' })
	await expect(previewDialog).toBeVisible()
	await expect(previewDialog.locator('.sd-preview-content')).toHaveText(FRONTEND_FIXTURE_TEXTS[0], {
		timeout: 30_000,
	})
	await previewDialog.getByRole('button', { name: 'Close' }).click()
	await expect(previewDialog).toBeHidden()

	// Network-capture assertion: NO request this test has made so far (wallet
	// auth challenge, Seal session cert, Walrus blob read, Seal key-server
	// fetch_key) ever carried the plaintext or the owner's private key in a
	// request body. Re-asserted at the end of the test (after the delete
	// steps) since `requestBodies` keeps accumulating for the test's full
	// lifetime and the delete-phase requests deserve the same guarantee.
	for (const text of FRONTEND_FIXTURE_TEXTS) {
		expect(requestBodies.some((body) => body.includes(text))).toBe(false)
	}
	expect(requestBodies.some((body) => body.includes(devstack.ownerSuiPrivateKey))).toBe(false)

	// 4. Select 2 of the 3 rows and delete them.
	await page.getByLabel(`Select ${seededBlobIds[0]}`).check()
	await page.getByLabel(`Select ${seededBlobIds[1]}`).check()
	await page.getByRole('button', { name: /^Delete selected/ }).click()
	await page.getByRole('dialog', { name: /Permanently delete/ }).getByRole('button', { name: 'Delete forever' }).click()

	// 5. Rows move to the Deleted tab as `deleted`; the 3rd (untouched) row
	// stays in "Stored". Real wallet-tx completion + real server submit,
	// polled via the UI's own refresh — no client-side pretending.
	await expect(page.getByTitle(seededBlobIds[0], { exact: true })).toHaveCount(0, { timeout: 30_000 })
	await expect(page.getByTitle(seededBlobIds[1], { exact: true })).toHaveCount(0, { timeout: 30_000 })
	await expect(page.getByTitle(seededBlobIds[2], { exact: true })).toBeVisible()

	await page.getByRole('tab', { name: 'Deleted' }).click()
	for (const blobId of [seededBlobIds[0], seededBlobIds[1]]) {
		const row = page.locator('tr', { has: page.getByTitle(blobId, { exact: true }) })
		await expect(row).toBeVisible({ timeout: 30_000 })
		await expect(row.locator('.sd-state')).toHaveText('deleted')
	}
	// Exact counts delta: the 2 deleted rows left "Stored" and landed in
	// "Deleted", nothing stuck in progress (baseline captured in step 2).
	await expect(countsLine).toHaveText(
		`${countsBefore.atRisk - 2} stored, 0 in progress, ${countsBefore.deleted + 2} deleted`,
		{ timeout: 30_000 },
	)

	// 6. Popup-count contract (spec §10): exactly 1 explicitly initiated
	// personal-message signature (security-delete auth challenge — the same cached token
	// covers list/prepare/submit) + 1 Seal-session personal-message
	// signature (cached across preview clicks, only 1 preview click here) +
	// 1 tx signature (both selected rows delete in a single batch, well
	// under DELETE_BATCH_MAX). See useSecurityDeletion.ts/blobPreview.ts.
	const calls = await walletCalls(page)
	const byType = (type: E2EWalletCall['type']) => calls.filter((c) => c.type === type)
	expect(byType('sign-personal-message'), JSON.stringify(calls)).toHaveLength(2)
	expect(byType('sign-transaction'), JSON.stringify(calls)).toHaveLength(1)
	expect(byType('sign-and-execute-transaction'), JSON.stringify(calls)).toHaveLength(0)

	// Re-run the network-capture assertion now that every step (including
	// the delete-phase submit/prepare requests) has fired: still no request
	// body, across the test's full lifetime, ever carried a seeded plaintext
	// or the owner's private key.
	for (const text of FRONTEND_FIXTURE_TEXTS) {
		expect(requestBodies.some((body) => body.includes(text))).toBe(false)
	}
	expect(requestBodies.some((body) => body.includes(devstack.ownerSuiPrivateKey))).toBe(false)
})
