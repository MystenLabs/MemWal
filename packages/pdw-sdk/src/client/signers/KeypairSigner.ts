/**
 * Keypair Signer Implementation
 *
 * Wraps @mysten/sui Keypair for use with SimplePDWClient.
 * Suitable for Node.js, backend services, CLI tools.
 *
 * @example
 * ```typescript
 * import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
 * import { KeypairSigner } from 'personal-data-wallet-sdk/client';
 *
 * const keypair = Ed25519Keypair.fromSecretKey(privateKey);
 * const signer = new KeypairSigner(keypair, suiClient);
 *
 * const pdw = await createPDWClient({
 *   signer,
 *   network: 'testnet'
 * });
 * ```
 *
 * @module client/signers
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Keypair, Signer } from '@mysten/sui/cryptography';
import type { Transaction } from '@mysten/sui/transactions';
import type {
  UnifiedSigner,
  SignAndExecuteResult,
  SignPersonalMessageResult
} from './UnifiedSigner';

/**
 * Keypair-based signer for Node.js and backend environments
 */
export class KeypairSigner implements UnifiedSigner {
  constructor(
    private keypair: Keypair,
    private client: SuiClient
  ) {}

  /**
   * Sign and execute transaction using keypair
   */
  async signAndExecuteTransaction(transaction: Transaction): Promise<SignAndExecuteResult> {
    const result = await this.client.signAndExecuteTransaction({
      transaction,
      signer: this.keypair,
      options: {
        showEffects: true,
        showEvents: true,
        showObjectChanges: true
      }
    });

    return {
      digest: result.digest,
      effects: result.effects,
      events: result.events || undefined,
      objectChanges: result.objectChanges || undefined
    };
  }

  /**
   * Sign personal message using keypair
   */
  async signPersonalMessage(message: Uint8Array): Promise<SignPersonalMessageResult> {
    const { signature } = await this.keypair.signPersonalMessage(message);

    return {
      signature,  // Base64 string
      bytes: message  // Original message bytes
    };
  }

  /**
   * Get Sui address from keypair
   */
  getAddress(): string {
    return this.keypair.getPublicKey().toSuiAddress();
  }

  /**
   * Get public key bytes
   */
  getPublicKey(): Uint8Array {
    return this.keypair.getPublicKey().toRawBytes();
  }

  /**
   * Get underlying Signer (Keypair)
   */
  getSigner(): Signer {
    return this.keypair;
  }
}
