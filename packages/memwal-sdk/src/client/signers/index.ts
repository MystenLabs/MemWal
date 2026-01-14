/**
 * Signer Abstractions for SimplePDWClient
 *
 * Unified signer interface supporting multiple signing methods:
 * - Keypair (Node.js, backend, CLI)
 * - WalletAdapter (Browser, React dApps)
 * - DappKit (Browser, @mysten/dapp-kit hooks)
 *
 * @module client/signers
 */

export type {
  UnifiedSigner,
  SignAndExecuteResult,
  SignPersonalMessageResult
} from './UnifiedSigner';

export { KeypairSigner } from './KeypairSigner';
export { WalletAdapterSigner } from './WalletAdapterSigner';
export type { WalletAdapter } from './WalletAdapterSigner';
export { DappKitSigner } from './DappKitSigner';
export type {
  DappKitSignerConfig,
  DappKitSignAndExecuteFn,
  DappKitSignPersonalMessageFn
} from './DappKitSigner';
