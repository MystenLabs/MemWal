/**
 * Cross-Context Permission Service
 * 
 * Manages cross-context access permissions for the Personal Data Wallet.
 * Enables apps to request and manage access to data from other app contexts.
 */

import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { SuiClient } from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';

export interface CrossContextPermissionConfig {
  packageId: string;
  accessRegistryId: string;
}

export interface RegisterContextWalletOptions {
  contextWallet: string;
  derivationIndex: number;
  appHint?: string;
}

export interface GrantWalletAllowlistOptions {
  requestingWallet: string;
  targetWallet: string;
  scope?: string;
  accessLevel: 'read' | 'write';
  expiresAt: number; // Unix timestamp in milliseconds
}

export interface RevokeWalletAllowlistOptions {
  requestingWallet: string;
  targetWallet: string;
  scope?: string;
}

export interface WalletAllowlistPermission {
  requestingWallet: string;
  targetWallet: string;
  scope: string;
  accessLevel: string;
  grantedAt: number;
  expiresAt: number;
  grantedBy: string;
}

export interface WalletAllowlistHistoryEvent {
  timestamp: number;
  action: 'grant' | 'revoke';
  requestingWallet: string;
  targetWallet: string;
  scope: string;
  accessLevel: string;
  expiresAt: number;
  grantedBy: string;
}

export interface WalletAllowlistHistoryFilter {
  requestingWallet?: string;
  targetWallet?: string;
}

export interface CheckWalletAccessOptions {
  requestingWallet: string;
  targetWallet?: string;
  scope?: string;
}

interface WalletAllowlistEvent {
  key: string;
  requestingWallet: string;
  targetWallet: string;
  scope: string;
  accessLevel: string;
  granted: boolean;
  expiresAt: number;
  grantedAt: number;
  grantedBy: string;
}

/**
 * Service for managing cross-context permissions
 */
export class CrossContextPermissionService {
  private packageId: string;
  private accessRegistryId: string;
  private client: SuiClient;

  constructor(config: CrossContextPermissionConfig, client: SuiClient) {
    this.packageId = config.packageId;
    this.accessRegistryId = config.accessRegistryId;
    this.client = client;
  }

  /**
   * Register a new context wallet for an app
   * 
   * @param options - Context registration options
   * @param signer - Transaction signer
   * @returns Transaction digest
   */
  async registerContextWallet(
    options: RegisterContextWalletOptions,
    signer: Signer
  ): Promise<string> {
    const tx = this.buildRegisterContextWalletTransaction(options);
    
    const result = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: {
        showEffects: true,
        showEvents: true,
      },
    });

    // Wait for transaction to be finalized to prevent gas coin version conflicts
    if (result.digest) {
      await this.client.waitForTransaction({ digest: result.digest });
    }

    if (result.effects?.status?.status !== 'success') {
      throw new Error(`Failed to register context: ${result.effects?.status?.error}`);
    }

    return result.digest;
  }

  /**
   * Build transaction to register a context wallet
   * 
   * @param options - Context registration options
   * @returns Transaction object
   */
  buildRegisterContextWalletTransaction(options: RegisterContextWalletOptions): Transaction {
    const tx = new Transaction();

    tx.moveCall({
      target: `${this.packageId}::capability::register_context_wallet`,
      arguments: [
        tx.object(this.accessRegistryId),
        tx.pure.address(normalizeSuiAddress(options.contextWallet)),
        tx.pure.u64(options.derivationIndex),
        tx.pure.string(options.appHint ?? ''),
        tx.object('0x6'), // Clock object
      ],
    });

    return tx;
  }

  /**
   * Grant cross-context access permission
   * 
   * @param options - Permission grant options
   * @param signer - Transaction signer
   * @returns Transaction digest
   */
  async grantWalletAllowlistAccess(
    options: GrantWalletAllowlistOptions,
    signer: Signer
  ): Promise<string> {
    const tx = this.buildGrantWalletAllowlistTransaction(options);
    
    const result = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: {
        showEffects: true,
        showEvents: true,
      },
    });

    // Wait for transaction to be finalized to prevent gas coin version conflicts
    if (result.digest) {
      await this.client.waitForTransaction({ digest: result.digest });
    }

    if (result.effects?.status?.status !== 'success') {
      throw new Error(`Failed to grant access: ${result.effects?.status?.error}`);
    }

    return result.digest;
  }

  /**
   * Build transaction to grant cross-context access
   * 
   * @param options - Permission grant options
   * @returns Transaction object
   */
  buildGrantWalletAllowlistTransaction(
    options: GrantWalletAllowlistOptions
  ): Transaction {
    const tx = new Transaction();

    tx.moveCall({
      target: `${this.packageId}::capability::grant_wallet_allowlist_access`,
      arguments: [
        tx.object(this.accessRegistryId),
        tx.pure.address(normalizeSuiAddress(options.requestingWallet)),
        tx.pure.address(normalizeSuiAddress(options.targetWallet)),
        tx.pure.string(options.scope ?? 'read'),
        tx.pure.string(options.accessLevel),
        tx.pure.u64(options.expiresAt),
        tx.object('0x6'), // Clock object
      ],
    });

    return tx;
  }

  /**
   * Revoke cross-context access permission
   * 
   * @param options - Permission revocation options
   * @param signer - Transaction signer
   * @returns Transaction digest
   */
  async revokeWalletAllowlistAccess(
    options: RevokeWalletAllowlistOptions,
    signer: Signer
  ): Promise<string> {
    const tx = this.buildRevokeWalletAllowlistTransaction(options);
    
    const result = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: {
        showEffects: true,
        showEvents: true,
      },
    });

    // Wait for transaction to be finalized to prevent gas coin version conflicts
    if (result.digest) {
      await this.client.waitForTransaction({ digest: result.digest });
    }

    if (result.effects?.status?.status !== 'success') {
      throw new Error(`Failed to revoke access: ${result.effects?.status?.error}`);
    }

    return result.digest;
  }

  /**
   * Build transaction to revoke cross-context access
   * 
   * @param options - Permission revocation options
   * @returns Transaction object
   */
  buildRevokeWalletAllowlistTransaction(
    options: RevokeWalletAllowlistOptions
  ): Transaction {
    const tx = new Transaction();

    tx.moveCall({
      target: `${this.packageId}::capability::revoke_wallet_allowlist_access`,
      arguments: [
        tx.object(this.accessRegistryId),
        tx.pure.address(normalizeSuiAddress(options.requestingWallet)),
        tx.pure.address(normalizeSuiAddress(options.targetWallet)),
        tx.pure.string(options.scope ?? 'read'),
      ],
    });

    return tx;
  }

  /**
   * Build seal_approve transaction using capability module
   *
   * Uses pdw::capability::seal_approve which requires:
   * - id: vector<u8> - SEAL key identifier (MUST be first parameter!)
   * - cap: &MemoryCap - Reference to the capability object
   *
   * IMPORTANT: SEAL key server extracts 'id' from the FIRST PTB argument
   *
   * @param keyId - SEAL key ID bytes (computed from owner + nonce)
   * @param memoryCapId - MemoryCap object ID on Sui
   * @returns Transaction object
   */
  buildSealApproveTransaction(
    keyId: Uint8Array,
    memoryCapId: string
  ): Transaction {
    const tx = new Transaction();

    // CRITICAL: key_id MUST be first argument!
    // SEAL key server extracts 'id' from the FIRST PTB argument for decryption approval.
    tx.moveCall({
      target: `${this.packageId}::capability::seal_approve`,
      arguments: [
        tx.pure.vector('u8', Array.from(keyId)), // Arg 1: key_id bytes (SEAL key server requirement!)
        tx.object(memoryCapId), // Arg 2: MemoryCap reference
      ],
    });

    return tx;
  }

  /**
   * Build seal_approve transaction (legacy - for backward compatibility)
   * @deprecated Use buildSealApproveTransaction with memoryCapId instead
   */
  buildSealApproveTransactionLegacy(
    contentId: Uint8Array,
    requestingWallet: string
  ): Transaction {
    const tx = new Transaction();

    tx.moveCall({
      target: `${this.packageId}::capability::seal_approve`,
      arguments: [
        tx.pure.vector('u8', Array.from(contentId)),
        tx.pure.address(normalizeSuiAddress(requestingWallet)),
        tx.object(this.accessRegistryId),
        tx.object('0x6'), // Clock object
      ],
    });

    return tx;
  }

  /**
   * Query wallet allowlist permissions filtered by requester, target, or scope
   */
  async queryWalletPermissions(options: Partial<CheckWalletAccessOptions>): Promise<WalletAllowlistPermission[]> {
    const events = await this.fetchWalletAllowlistEvents();
    const state = this.reduceWalletAllowlistEvents(events);

    const normalizedRequester = options.requestingWallet ? normalizeSuiAddress(options.requestingWallet) : undefined;
    const normalizedTarget = options.targetWallet ? normalizeSuiAddress(options.targetWallet) : undefined;
    const scopeFilter = options.scope ?? undefined;

    return Array.from(state.values())
      .filter((permission) => {
        if (normalizedRequester && permission.requestingWallet !== normalizedRequester) {
          return false;
        }
        if (normalizedTarget && permission.targetWallet !== normalizedTarget) {
          return false;
        }
        if (scopeFilter && permission.scope !== scopeFilter) {
          return false;
        }
        return true;
      });
  }

  async listGrantsByTarget(targetWallet: string, scope?: string): Promise<WalletAllowlistPermission[]> {
    return this.queryWalletPermissions({ targetWallet, scope });
  }

  async listGrantsByRequester(requestingWallet: string, scope?: string): Promise<WalletAllowlistPermission[]> {
    return this.queryWalletPermissions({ requestingWallet, scope });
  }

  /**
   * Determine whether a wallet currently has allowlist permission
   */
  async hasWalletPermission(options: CheckWalletAccessOptions): Promise<boolean> {
    const permissions = await this.queryWalletPermissions(options);
    const now = Date.now();

    return permissions.some(permission => {
      const expiry = permission.expiresAt;
      return expiry === 0 || expiry > now;
    });
  }

  /**
   * List target wallets this requester can access for an optional scope
   */
  async getAccessibleWallets(requestingWallet: string, scope: string = 'read'): Promise<string[]> {
    const permissions = await this.queryWalletPermissions({ requestingWallet, scope });
    const now = Date.now();

    return permissions
      .filter(permission => permission.expiresAt === 0 || permission.expiresAt > now)
      .map(permission => permission.targetWallet);
  }

  async getWalletAllowlistHistory(
    filter?: WalletAllowlistHistoryFilter,
  ): Promise<WalletAllowlistHistoryEvent[]> {
    const events = await this.fetchWalletAllowlistEvents();
    const normalizedRequester = filter?.requestingWallet
      ? normalizeSuiAddress(filter.requestingWallet)
      : undefined;
    const normalizedTarget = filter?.targetWallet
      ? normalizeSuiAddress(filter.targetWallet)
      : undefined;

    return events
      .filter((event) => {
        if (normalizedRequester && event.requestingWallet !== normalizedRequester) {
          return false;
        }
        if (normalizedTarget && event.targetWallet !== normalizedTarget) {
          return false;
        }
        return true;
      })
      .map<WalletAllowlistHistoryEvent>((event) => ({
        timestamp: event.grantedAt,
        action: event.granted ? 'grant' : 'revoke',
        requestingWallet: event.requestingWallet,
        targetWallet: event.targetWallet,
        scope: event.scope,
        accessLevel: event.accessLevel,
        expiresAt: event.expiresAt,
        grantedBy: event.grantedBy,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  private async fetchWalletAllowlistEvents(): Promise<WalletAllowlistEvent[]> {
    const response = await this.client.queryEvents({
      query: {
        MoveEventType: `${this.packageId}::capability::WalletAllowlistChanged`,
      },
      limit: 1000,
      order: 'ascending',
    });

    const events: WalletAllowlistEvent[] = [];

    for (const event of response.data) {
      const parsed = event.parsedJson as any;
      if (!parsed) {
        continue;
      }

      const requestingWallet = normalizeSuiAddress(String(parsed.requester_wallet));
      const targetWallet = normalizeSuiAddress(String(parsed.target_wallet));
      const scope = String(parsed.scope ?? 'read');
      const accessLevel = String(parsed.access_level ?? 'read');
      const granted = Boolean(parsed.granted);
      const expiresAt = Number(parsed.expires_at ?? 0);
      const grantedBy = normalizeSuiAddress(String(parsed.granted_by ?? requestingWallet));
      const grantedAt = Number(event.timestampMs ?? Date.now());
      const key = `${requestingWallet}-${targetWallet}-${scope}`;

      events.push({
        key,
        requestingWallet,
        targetWallet,
        scope,
        accessLevel,
        granted,
        expiresAt,
        grantedAt,
        grantedBy,
      });
    }

    return events;
  }

  private reduceWalletAllowlistEvents(events: WalletAllowlistEvent[]): Map<string, WalletAllowlistPermission> {
    const state = new Map<string, WalletAllowlistPermission>();

    const sorted = [...events].sort((a, b) => a.grantedAt - b.grantedAt);

    for (const event of sorted) {
      if (event.granted) {
        state.set(event.key, {
          requestingWallet: event.requestingWallet,
          targetWallet: event.targetWallet,
          scope: event.scope,
          accessLevel: event.accessLevel,
          grantedAt: event.grantedAt,
          expiresAt: event.expiresAt,
          grantedBy: event.grantedBy,
        });
      } else {
        state.delete(event.key);
      }
    }

    return state;
  }
}
