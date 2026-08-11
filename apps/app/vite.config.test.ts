// @vitest-environment node
import { devWalletInjector } from './vite.config'

describe('devWalletInjector', () => {
  it('is disabled unless a private key is explicitly provided', () => {
    expect(devWalletInjector({ VITE_SUI_GRPC_URL: 'https://provider.example/grpc' })).toBeNull()
  })

  it('fails closed when an injected testnet wallet has no gRPC endpoint', () => {
    expect(() => devWalletInjector({
      DEV_WALLET_PRIVATE_KEY: 'suiprivkey1example',
      VITE_SUI_NETWORK: 'testnet',
      VITE_SUI_RPC_URL: 'https://provider.example/json-rpc',
    })).toThrow(/requires VITE_SUI_GRPC_URL/)
  })

  it('accepts a gRPC-only injected wallet configuration', () => {
    expect(devWalletInjector({
      DEV_WALLET_PRIVATE_KEY: 'suiprivkey1example',
      VITE_SUI_NETWORK: 'testnet',
      VITE_SUI_GRPC_URL: 'https://provider.example/grpc',
    })?.name).toBe('memwal-dev-wallet-injector')
  })
})
