/**
 * Signer Abstractions for SimplePDWClient
 *
 * Unified signer interface supporting multiple signing methods:
 * - Keypair (Node.js, backend, CLI)
 * - WalletAdapter (Browser, React dApps)
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
