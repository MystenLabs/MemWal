/**
 * Wallet Adapter Signer Implementation
 *
 * Wraps browser wallet adapters (Sui Wallet, Ethos, Suiet, etc.)
 * for use with SimplePDWClient in React dApps.
 *
 * @example
 * ```typescript
 * import { WalletAdapterSigner } from 'personal-data-wallet-sdk/client';
 *
 * // With @mysten/dapp-kit
 * const { currentWallet } = useCurrentWallet();
 * const signer = new WalletAdapterSigner(currentWallet);
 *
 * const pdw = await createPDWClient({
 *   signer,
 *   network: 'testnet'
 * });
 * ```
 *
 * @module client/signers
 */

import type { Transaction } from '@mysten/sui/transactions';
import type { Signer } from '@mysten/sui/cryptography';
import type {
  UnifiedSigner,
  SignAndExecuteResult,
  SignPersonalMessageResult
} from './UnifiedSigner';

/**
 * Minimal wallet adapter interface
 * Compatible with @mysten/dapp-kit and other wallet adapters
 */
export interface WalletAdapter {
  /**
   * Sign and execute transaction
   */
  signAndExecuteTransaction(options: {
    transaction: Transaction;
    options?: {
      showEffects?: boolean;
      showEvents?: boolean;
      showObjectChanges?: boolean;
    };
  }): Promise<{
    digest: string;
    effects?: any;
    events?: any[];
    objectChanges?: any[];
  }>;

  /**
   * Sign personal message
   */
  signPersonalMessage(options: {
    message: Uint8Array;
  }): Promise<{
    signature: string;
    bytes?: Uint8Array;
  }>;

  /**
   * Get account info
   */
  account: {
    address: string;
    publicKey?: Uint8Array;
  };
}

/**
 * Wallet adapter-based signer for browser environments
 */
export class WalletAdapterSigner implements UnifiedSigner {
  constructor(private walletAdapter: WalletAdapter) {
    if (!walletAdapter) {
      throw new Error('WalletAdapter is required');
    }

    if (!walletAdapter.account || !walletAdapter.account.address) {
      throw new Error('Wallet not connected. Please connect wallet first.');
    }
  }

  /**
   * Sign and execute transaction using wallet adapter
   */
  async signAndExecuteTransaction(transaction: Transaction): Promise<SignAndExecuteResult> {
    const result = await this.walletAdapter.signAndExecuteTransaction({
      transaction,
      options: {
        showEffects: true,
        showEvents: true,
        showObjectChanges: true
      }
    });

    return {
      digest: result.digest,
      effects: result.effects,
      events: result.events,
      objectChanges: result.objectChanges
    };
  }

  /**
   * Sign personal message using wallet adapter
   */
  async signPersonalMessage(message: Uint8Array): Promise<SignPersonalMessageResult> {
    const result = await this.walletAdapter.signPersonalMessage({
      message
    });

    return {
      signature: result.signature,
      bytes: result.bytes || message  // Fallback to original message if bytes not provided
    };
  }

  /**
   * Get Sui address from wallet
   */
  getAddress(): string {
    return this.walletAdapter.account.address;
  }

  /**
   * Get public key from wallet
   */
  getPublicKey(): Uint8Array | null {
    return this.walletAdapter.account.publicKey || null;
  }

  /**
   * Get underlying Signer
   *
   * Note: Wallet adapters don't expose full Signer interface,
   * so this throws an error. Use KeypairSigner for services requiring Signer.
   */
  getSigner(): Signer {
    throw new Error(
      'WalletAdapterSigner does not expose underlying Signer. ' +
      'Some PDW operations require direct Keypair access. ' +
      'Use KeypairSigner for backend/Node.js environments.'
    );
  }

  /**
   * Get SuiClient instance
   *
   * Note: WalletAdapter doesn't provide SuiClient.
   * Use DappKitSigner if you need client access.
   */
  getClient(): null {
    return null;
  }
}
