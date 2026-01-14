/**
 * Unified Signer Interface
 *
 * Abstracts signing operations to work with both:
 * - Keypair (Node.js, backend, CLI)
 * - WalletAdapter (Browser, React dApps)
 *
 * This allows SimplePDWClient to work in any environment.
 *
 * @module client/signers
 */

import type { Transaction } from '@mysten/sui/transactions';
import type { Signer } from '@mysten/sui/cryptography';
import type { SuiClient } from '@mysten/sui/client';

/**
 * Result of signing and executing a transaction
 */
export interface SignAndExecuteResult {
  /**
   * Transaction digest
   */
  digest: string;

  /**
   * Transaction effects
   */
  effects?: any;

  /**
   * Events emitted
   */
  events?: any[];

  /**
   * Object changes
   */
  objectChanges?: any[];
}

/**
 * Result of signing a personal message
 */
export interface SignPersonalMessageResult {
  /**
   * Signature (Base64-encoded string)
   */
  signature: string;

  /**
   * Signed bytes
   */
  bytes: Uint8Array;
}

/**
 * Unified Signer Interface
 *
 * Provides consistent signing API across different wallet types
 */
export interface UnifiedSigner {
  /**
   * Sign and execute a transaction on Sui blockchain
   *
   * @param transaction - The transaction to sign and execute
   * @returns Transaction result with digest and effects
   */
  signAndExecuteTransaction(transaction: Transaction): Promise<SignAndExecuteResult>;

  /**
   * Sign a personal message (for SEAL encryption identity)
   *
   * @param message - The message bytes to sign
   * @returns Signature result
   */
  signPersonalMessage(message: Uint8Array): Promise<SignPersonalMessageResult>;

  /**
   * Get the Sui address of this signer
   *
   * @returns Sui address (0x-prefixed hex string)
   */
  getAddress(): string;

  /**
   * Get the public key (if available)
   *
   * @returns Public key bytes or null
   */
  getPublicKey?(): Uint8Array | null;

  /**
   * Get the underlying Signer (for services that need full Signer interface)
   *
   * Note: This may not be available for all signer types (e.g., wallet adapters)
   * @returns Signer instance or throws error if not available
   */
  getSigner(): Signer;

  /**
   * Get the SuiClient instance (optional)
   *
   * Used by managers that need to build transactions or wait for confirmations.
   * Returns null if not available (e.g., WalletAdapterSigner).
   *
   * @returns SuiClient instance or null
   */
  getClient?(): SuiClient | null;
}
