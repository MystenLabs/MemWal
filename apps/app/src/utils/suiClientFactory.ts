import { SuiGrpcClient } from '@mysten/sui/grpc'
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc'

export interface AppSuiClientOptions {
    network: string
    grpcUrl: string
    jsonRpcUrl?: string
    /** Explicit localnet-only browser-suite compatibility transport. */
    localE2eJsonRpc?: boolean
}

export type AppSuiClient = SuiGrpcClient | SuiJsonRpcClient

/** Construct the app's Sui transport, failing closed when gRPC is required. */
export function createAppSuiClient(options: AppSuiClientOptions): AppSuiClient {
    if (options.localE2eJsonRpc) {
        if (options.network !== 'localnet') {
            throw new Error('VITE_SUI_LOCAL_E2E_JSON_RPC requires VITE_SUI_NETWORK=localnet')
        }
        if (!options.jsonRpcUrl) {
            throw new Error('VITE_SUI_RPC_URL is required when VITE_SUI_LOCAL_E2E_JSON_RPC=true')
        }
        const hostname = new URL(options.jsonRpcUrl).hostname
        if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
            throw new Error('VITE_SUI_LOCAL_E2E_JSON_RPC only permits a loopback endpoint')
        }
        return new SuiJsonRpcClient({ network: options.network, url: options.jsonRpcUrl })
    }

    if (!options.grpcUrl) {
        throw new Error(`VITE_SUI_GRPC_URL is required for the active ${options.network} network`)
    }
    return new SuiGrpcClient({ network: options.network, baseUrl: options.grpcUrl })
}
