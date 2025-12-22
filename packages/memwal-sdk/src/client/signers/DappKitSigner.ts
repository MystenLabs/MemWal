/**
 * DappKit Signer Implementation
 *
 * Adapter for @mysten/dapp-kit hooks to work with SimplePDWClient.
 * Bridges dApp-kit's hook-based API with SDK's UnifiedSigner interface.
 *
 * @example
 * ```typescript
 * import { DappKitSigner, createSimplePDWClient } from '@cmdoss/memwal-sdk';
 * import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
 *
 * function MyComponent() {
 *   const account = useCurrentAccount();
 *   const client = useSuiClient();
 *   const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
 *
 *   const signer = useMemo(() => {
 *     if (!account) return null;
 *     return new DappKitSigner({
 *       address: account.address,
 *       client,
 *       signAndExecuteTransaction: signAndExecute,
 *     });
 *   }, [account, client, signAndExecute]);
 *
 *   // Now use signer with SDK
 *   const pdw = await createSimplePDWClient({ signer, network: 'testnet' });
 * }
 * ```
 *
 * @module client/signers
 */

import type { Transaction } from '@mysten/sui/transactions';
import type { SuiClient } from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';
import type {
  UnifiedSigner,
  SignAndExecuteResult,
  SignPersonalMessageResult
} from './UnifiedSigner';

/**
 * Function signature for dApp-kit's signAndExecuteTransaction
 * Compatible with useSignAndExecuteTransaction().mutateAsync
 */
export interface DappKitSignAndExecuteFn {
  (params: { transaction: Transaction }): Promise<{
    digest: string;
    effects?: any;
    events?: any[];
    objectChanges?: any[];
  }>;
}

/**
 * Function signature for dApp-kit's signPersonalMessage
 * Compatible with useSignPersonalMessage().mutateAsync
 */
export interface DappKitSignPersonalMessageFn {
  (params: { message: Uint8Array }): Promise<{
    signature: string;
    bytes?: Uint8Array;
  }>;
}

/**
 * Configuration for DappKitSigner
 */
export interface DappKitSignerConfig {
  /**
   * User's Sui address (from useCurrentAccount().address)
   */
  address: string;

  /**
   * SuiClient instance (from useSuiClient())
   */
  client: SuiClient;

  /**
   * signAndExecuteTransaction function (from useSignAndExecuteTransaction().mutateAsync)
   */
  signAndExecuteTransaction: DappKitSignAndExecuteFn;

  /**
   * signPersonalMessage function (from useSignPersonalMessage().mutateAsync)
   * Optional - only required for operations that need message signing
   */
  signPersonalMessage?: DappKitSignPersonalMessageFn;

  /**
   * Public key bytes (optional, from useCurrentAccount().publicKey)
   */
  publicKey?: Uint8Array;
}

/**
 * DappKitSigner - Adapter for @mysten/dapp-kit hooks
 *
 * Wraps dApp-kit's useSignAndExecuteTransaction and useSignPersonalMessage hooks
 * to provide a UnifiedSigner interface compatible with SDK managers.
 *
 * This adapter does NOT depend on React - it accepts function references
 * that can come from dApp-kit hooks or any other source with compatible signatures.
 */
export class DappKitSigner implements UnifiedSigner {
  private config: DappKitSignerConfig;

  constructor(config: DappKitSignerConfig) {
    if (!config.address) {
      throw new Error('DappKitSigner requires an address');
    }
    if (!config.client) {
      throw new Error('DappKitSigner requires a SuiClient');
    }
    if (!config.signAndExecuteTransaction) {
      throw new Error('DappKitSigner requires signAndExecuteTransaction function');
    }
    this.config = config;
  }

  /**
   * Sign and execute transaction using dApp-kit hook
   *
   * Wraps the dApp-kit signAndExecuteTransaction function and waits for
   * transaction finalization to prevent gas coin version conflicts.
   */
  async signAndExecuteTransaction(transaction: Transaction): Promise<SignAndExecuteResult> {
    const result = await this.config.signAndExecuteTransaction({ transaction });

    // Wait for transaction to be finalized (important for gas coin versioning)
    if (result.digest) {
      try {
        await this.config.client.waitForTransaction({ digest: result.digest });
      } catch (waitError) {
        console.warn('DappKitSigner: waitForTransaction failed:', waitError);
        // Continue anyway - transaction was submitted
      }
    }

    return {
      digest: result.digest,
      effects: result.effects,
      events: result.events,
      objectChanges: result.objectChanges,
    };
  }

  /**
   * Sign personal message using dApp-kit hook
   *
   * Required for SEAL encryption identity and other message signing operations.
   */
  async signPersonalMessage(message: Uint8Array): Promise<SignPersonalMessageResult> {
    if (!this.config.signPersonalMessage) {
      throw new Error(
        'DappKitSigner: signPersonalMessage not configured. ' +
        'Pass signPersonalMessage function from useSignPersonalMessage().mutateAsync'
      );
    }

    const result = await this.config.signPersonalMessage({ message });

    return {
      signature: result.signature,
      bytes: result.bytes || message,
    };
  }

  /**
   * Get Sui address
   */
  getAddress(): string {
    return this.config.address;
  }

  /**
   * Get public key (if available)
   */
  getPublicKey(): Uint8Array | null {
    return this.config.publicKey || null;
  }

  /**
   * Get underlying Signer
   *
   * Note: dApp-kit does not expose the underlying Signer for security reasons.
   * Use KeypairSigner for backend/Node.js environments that need raw Signer access.
   */
  getSigner(): Signer {
    throw new Error(
      'DappKitSigner does not expose underlying Signer. ' +
      'Browser wallets do not provide raw Signer access for security. ' +
      'Use KeypairSigner for backend/Node.js environments.'
    );
  }

  /**
   * Get SuiClient
   *
   * Returns the SuiClient instance for managers that need to build transactions.
   */
  getClient(): SuiClient {
    return this.config.client;
  }
}
