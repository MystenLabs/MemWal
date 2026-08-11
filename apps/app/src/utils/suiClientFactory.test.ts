import { isSuiGrpcClient } from '@mysten/sui/grpc'
import { isSuiJsonRpcClient } from '@mysten/sui/jsonRpc'

import { createAppSuiClient } from './suiClientFactory'

describe('createAppSuiClient', () => {
    it('constructs a branded gRPC client for real testnet', () => {
        const client = createAppSuiClient({
            network: 'testnet',
            grpcUrl: 'https://provider.example/grpc',
        })

        expect(isSuiGrpcClient(client)).toBe(true)
        expect(isSuiJsonRpcClient(client)).toBe(false)
    })

    it('fails closed instead of falling back to JSON-RPC', () => {
        expect(() => createAppSuiClient({
            network: 'testnet',
            grpcUrl: '',
            jsonRpcUrl: 'https://provider.example/json-rpc',
        })).toThrow(/VITE_SUI_GRPC_URL is required/)
    })

    it('allows JSON-RPC only through the explicit local E2E escape hatch', () => {
        const client = createAppSuiClient({
            network: 'localnet',
            grpcUrl: '',
            jsonRpcUrl: 'http://127.0.0.1:9000',
            localE2eJsonRpc: true,
        })

        expect(isSuiJsonRpcClient(client)).toBe(true)
        expect(isSuiGrpcClient(client)).toBe(false)
    })

    it('rejects non-local JSON-RPC even when the E2E flag is set', () => {
        expect(() => createAppSuiClient({
            network: 'localnet',
            grpcUrl: '',
            jsonRpcUrl: 'https://provider.example/json-rpc',
            localE2eJsonRpc: true,
        })).toThrow(/only permits a loopback endpoint/)
    })

    it('rejects JSON-RPC for testnet even when loopback and the E2E flag are set', () => {
        expect(() => createAppSuiClient({
            network: 'testnet',
            grpcUrl: '',
            jsonRpcUrl: 'http://127.0.0.1:9000',
            localE2eJsonRpc: true,
        })).toThrow(/requires VITE_SUI_NETWORK=localnet/)
    })
})
