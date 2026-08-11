/**
 * Shared WalrusClient factory (per-SuiClient cache). Used by the
 * security-delete preview to read blob bytes from Walrus.
 */

import type { useSuiClient } from '@mysten/dapp-kit'
import { WalrusClient } from '@mysten/walrus'
// Vite's default dependency resolution can't locate the wasm-pack output
// @mysten/walrus's encoder needs (a request for it 404s to the SPA's
// index.html, which then fails `WebAssembly.instantiate` on the HTML bytes)
// — the package's own docs prescribe this `?url` import as the fix. See
// node_modules/@mysten/walrus/docs/index.md "Loading the wasm module in
// vite or client side apps".
import walrusWasmUrl from '@mysten/walrus-wasm/web/walrus_wasm_bg.wasm?url'
import { config } from '../config'

type SuiClient = ReturnType<typeof useSuiClient>

const walrusClients = new WeakMap<object, WalrusClient>()

export function getWalrusClient(suiClient: SuiClient): WalrusClient {
    let client = walrusClients.get(suiClient as object)
    if (!client) {
        // WalrusClient only resolves package/staking ids itself for
        // "mainnet"/"testnet" — a devstack localnet needs them supplied
        // directly via packageConfig, mirroring the sidecar's
        // createWalrusClient (services/server/scripts/sidecar/clients.ts).
        const networkConfig = config.walrusSystemObjectId && config.walrusStakingPoolId
            ? {
                packageConfig: {
                    systemObjectId: config.walrusSystemObjectId,
                    stakingPoolId: config.walrusStakingPoolId,
                },
            }
            : { network: config.suiNetwork }
        client = new WalrusClient({
            ...networkConfig,
            suiClient: suiClient as never,
            wasmUrl: walrusWasmUrl,
        })
        walrusClients.set(suiClient as object, client)
    }
    return client
}

