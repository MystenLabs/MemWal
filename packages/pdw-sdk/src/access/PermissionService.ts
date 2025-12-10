/**
 * PermissionService - OAuth-style access control management
 * 
 * Manages permissions for cross-app data access, including:
 * - OAuth-style consent requests and grants
 * - Permission validation and enforcement
 * - On-chain access control integration
 * - Permission auditing and revocation
 */

// Use Web Crypto API (browser-compatible)
const randomUUID = (): string => crypto.randomUUID();
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { Signer } from '@mysten/sui/cryptography';

import { 
  ConsentRequest,
  ConsentRequestRecord,
  ConsentStatus,
  AccessGrant,
  PermissionScope,
  RequestConsentOptions,
  GrantPermissionsOptions,
  RevokePermissionsOptions 
} from '../types/wallet.js';
import { ContextWalletService } from '../wallet/ContextWalletService.js';
import { CrossContextPermissionService } from '../services/CrossContextPermissionService';
import type { WalletAllowlistPermission } from '../services/CrossContextPermissionService';
import type { ConsentRepository } from '../permissions/ConsentRepository.js';

/**
 * Configuration for PermissionService
 */
export interface PermissionServiceConfig {
  /** Sui client instance */
  suiClient: SuiClient;
  /** Package ID for Move contracts */
  packageId: string;
  /** Access registry ID for wallet allowlists */
  accessRegistryId: string;
  /** API URL for backend consent UI */
  apiUrl?: string;
  /** ContextWalletService for validation */
  contextWalletService?: ContextWalletService;
  /** Optional injected cross-context permission service */
  crossContextPermissionService?: CrossContextPermissionService;
  /** Optional repository for consent persistence */
  consentRepository?: ConsentRepository;
}

/**
 * PermissionService handles OAuth-style access control
 */
export class PermissionService {
  private suiClient: SuiClient;
  private packageId: string;
  private apiUrl: string;
  private contextWalletService?: ContextWalletService;
  private crossContextPermissions: CrossContextPermissionService;
  private pendingConsents: Map<string, ConsentRequestRecord> = new Map();
  private consentRepository?: ConsentRepository;

  constructor(config: PermissionServiceConfig) {
    this.suiClient = config.suiClient;
    this.packageId = config.packageId;
    this.apiUrl = config.apiUrl || 'http://localhost:3001/api';
    this.contextWalletService = config.contextWalletService;
    this.consentRepository = config.consentRepository;

    if (!config.accessRegistryId) {
      throw new Error('PermissionService requires accessRegistryId for wallet-based permissions');
    }

    this.crossContextPermissions =
      config.crossContextPermissionService ??
      new CrossContextPermissionService(
        {
          packageId: this.packageId,
          accessRegistryId: config.accessRegistryId,
        },
        this.suiClient,
      );
  }

  /**
   * Request user consent for accessing data
   * @param options - Consent request options
   * @returns Created consent request
   */
  async requestConsent(options: RequestConsentOptions): Promise<ConsentRequestRecord> {
    const requesterWallet = normalizeSuiAddress(options.requesterWallet);
    const targetWallet = normalizeSuiAddress(options.targetWallet);
    const now = Date.now();

    const requestId = randomUUID();
    const consentRequest: ConsentRequestRecord = {
      requesterWallet,
      targetWallet,
      targetScopes: options.scopes,
      purpose: options.purpose,
      expiresAt: options.expiresIn ? now + options.expiresIn : undefined,
      requestId,
      createdAt: now,
      updatedAt: now,
      status: 'pending',
    };

    await this.persistConsentRequest(consentRequest);

    // TODO: Send consent request to backend for UI presentation
    // For now, return the persisted record so callers can track status locally
    return consentRequest;
  }

  /**
   * Grant permissions to an app (user approval)
   * @param userAddress - User granting permissions
   * @param options - Grant options
   * @returns Created access grant
   */
  async grantPermissions(
    userAddress: string,
    options: GrantPermissionsOptions & { signer?: Signer }
  ): Promise<AccessGrant> {
    const requestingWallet = normalizeSuiAddress(options.requestingWallet);
    const targetWallet = normalizeSuiAddress(options.targetWallet);
    if (this.contextWalletService) {
      const ownsContext = await this.contextWalletService.validateAccess(targetWallet, userAddress);
      if (!ownsContext) {
        throw new Error('User does not own the specified target wallet');
      }
    }

    let lastDigest: string | undefined;
    if (options.signer) {
      for (const scope of options.scopes) {
        const accessLevel = scope.startsWith('write:') ? 'write' : 'read';
        lastDigest = await this.crossContextPermissions.grantWalletAllowlistAccess(
          {
            requestingWallet,
            targetWallet,
            scope,
            accessLevel,
            expiresAt: options.expiresAt ?? 0,
          },
          options.signer,
        );
      }
    }

    const permissions = await this.crossContextPermissions.queryWalletPermissions({
      requestingWallet,
      targetWallet,
    });

    const grantFromChain = this.buildGrantFromPermissions(
      requestingWallet,
      targetWallet,
      permissions,
    );

    const now = Date.now();
    let grant: AccessGrant =
      grantFromChain ?? {
        id: `grant_${requestingWallet}_${targetWallet}_${now}`,
        requestingWallet,
        targetWallet,
        scopes: options.scopes,
        expiresAt: options.expiresAt,
        grantedAt: now,
      };

    if (lastDigest) {
      grant = {
        ...grant,
        transactionDigest: lastDigest,
      };
    }
    await this.updateConsentStatus({
      requesterWallet: requestingWallet,
      targetWallet,
      newStatus: 'approved',
      updatedAt: now,
    });

    return grant;
  }

  /**
   * Revoke permissions from an app
   * @param userAddress - User revoking permissions
   * @param options - Revoke options
   * @returns Success status
   */
  async revokePermissions(
    userAddress: string,
    options: RevokePermissionsOptions & { signer?: Signer }
  ): Promise<boolean> {
    const requestingWallet = normalizeSuiAddress(options.requestingWallet);
    const targetWallet = normalizeSuiAddress(options.targetWallet);

    if (this.contextWalletService) {
      const ownsContext = await this.contextWalletService.validateAccess(targetWallet, userAddress);
      if (!ownsContext) {
        throw new Error('User does not own the specified target wallet');
      }
    }

    if (options.signer) {
      await this.crossContextPermissions.revokeWalletAllowlistAccess(
        {
          requestingWallet,
          targetWallet,
          scope: options.scope,
        },
        options.signer,
      );
    }

    return true;
  }

  /**
   * Determine if a requesting wallet currently has permission to access a target wallet
   */
  async hasWalletPermission(
    requestingWallet: string,
    targetWallet: string,
    scope: PermissionScope
  ): Promise<boolean> {
    return await this.crossContextPermissions.hasWalletPermission({
      requestingWallet: normalizeSuiAddress(requestingWallet),
      targetWallet: normalizeSuiAddress(targetWallet),
      scope,
    });
  }

  /**
   * Legacy compatibility method for app-scoped permission checks
   * Interprets appId as requesting wallet address.
   */
  async checkPermission(
    appId: string,
    scope: PermissionScope,
    userAddressOrTargetWallet: string
  ): Promise<boolean> {
    return await this.hasWalletPermission(appId, userAddressOrTargetWallet, scope);
  }

  /**
   * Get all access grants by a user
   * @param userAddress - User address
   * @returns Array of access grants
   */
  async getGrantsByUser(userAddress: string): Promise<AccessGrant[]> {
    const normalized = normalizeSuiAddress(userAddress);
    const permissions = await this.crossContextPermissions.listGrantsByTarget(normalized);
    return this.convertPermissionsToGrants(permissions);
  }

  /**
   * List all consent requests for a user
   * @param userAddress - User address
   * @returns Array of pending consent requests
   */
  async getPendingConsents(userAddress: string): Promise<ConsentRequest[]> {
    const normalized = normalizeSuiAddress(userAddress);
    if (this.consentRepository) {
      return await this.consentRepository.listByTarget(normalized, 'pending');
    }
    return Array.from(this.pendingConsents.values())
      .filter((request) => request.targetWallet === normalized && request.status === 'pending')
      .map((request) => ({ ...request }));
  }

  /**
   * Approve a consent request
   * @param userAddress - User approving the request
   * @param consentRequest - Consent request to approve
   * @param contextId - Context ID to grant access to
   * @returns Created access grant
   */
  async approveConsent(
    userAddress: string, 
    consentRequest: ConsentRequest, 
    _contextId: string
  ): Promise<AccessGrant> {
    const grant = await this.grantPermissions(userAddress, {
      requestingWallet: consentRequest.requesterWallet,
      targetWallet: consentRequest.targetWallet,
      scopes: consentRequest.targetScopes,
      expiresAt: consentRequest.expiresAt
    });

    const updatedAt = Date.now();
    if (consentRequest.requestId) {
      await this.updateConsentStatus({
        requesterWallet: consentRequest.requesterWallet,
        targetWallet: consentRequest.targetWallet,
        newStatus: 'approved',
        updatedAt,
        requestId: consentRequest.requestId,
      });
    }

    return grant;
  }

  /**
   * Deny a consent request
   * @param userAddress - User denying the request
   * @param consentRequest - Consent request to deny
   * @returns Success status
   */
  async denyConsent(userAddress: string, consentRequest: ConsentRequest): Promise<boolean> {
    const now = Date.now();
    if (consentRequest.requestId) {
      await this.updateConsentStatus({
        requesterWallet: consentRequest.requesterWallet,
        targetWallet: consentRequest.targetWallet,
        newStatus: 'denied',
        updatedAt: now,
        requestId: consentRequest.requestId,
      });
    } else {
      const inferredRequestId = randomUUID();
      await this.persistConsentRequest({
        ...consentRequest,
        requestId: inferredRequestId,
        createdAt: now,
        updatedAt: now,
        status: 'denied',
      });
    }

    return true;
  }

  /**
   * Get permission audit log for a user
   * @param userAddress - User address
   * @returns Array of permission events
   */
  async getPermissionAudit(userAddress: string): Promise<Array<{
    timestamp: number;
    action: 'grant' | 'revoke' | 'request' | 'deny';
    requestingWallet: string;
    targetWallet: string;
    scopes: PermissionScope[];
  }>> {
    const normalized = normalizeSuiAddress(userAddress);
    const auditEntries: Array<{
      timestamp: number;
      action: 'grant' | 'revoke' | 'request' | 'deny';
      requestingWallet: string;
      targetWallet: string;
      scopes: PermissionScope[];
    }> = [];

    const consentRecords = this.consentRepository
      ? await this.consentRepository.listByTarget(normalized)
      : Array.from(this.pendingConsents.values()).filter((request) => request.targetWallet === normalized);

    for (const request of consentRecords) {
      auditEntries.push({
        timestamp: request.createdAt,
        action: 'request',
        requestingWallet: request.requesterWallet,
        targetWallet: request.targetWallet,
        scopes: request.targetScopes,
      });

      if (request.status === 'denied') {
        auditEntries.push({
          timestamp: request.updatedAt,
          action: 'deny',
          requestingWallet: request.requesterWallet,
          targetWallet: request.targetWallet,
          scopes: request.targetScopes,
        });
      }
    }

    const history = await this.crossContextPermissions.getWalletAllowlistHistory({
      targetWallet: normalized,
    });

    for (const event of history) {
      auditEntries.push({
        timestamp: event.timestamp,
        action: event.action,
        requestingWallet: event.requestingWallet,
        targetWallet: event.targetWallet,
        scopes: [this.toPermissionScope(event.scope)],
      });
    }

    return auditEntries.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Validate OAuth-style permission for SEAL access control
   * @param walletOwner - Owner of the wallet
   * @param appId - Application requesting access
   * @param requestedScope - Required permission scope
   * @returns True if permission is valid
   */
  async validateOAuthPermission(
    walletOwner: string, 
    appId: string, 
    requestedScope: string
  ): Promise<boolean> {
    // This integrates with our existing SEAL access control
    return await this.hasWalletPermission(appId, walletOwner, requestedScope as PermissionScope);
  }

  /**
   * Build seal_approve transaction for a requesting wallet
   */
  createApprovalTransaction(
    contentId: Uint8Array,
    requestingWallet: string
  ): Transaction {
    return this.crossContextPermissions.buildSealApproveTransaction(
      contentId,
      normalizeSuiAddress(requestingWallet),
    );
  }

  /**
   * Get permission statistics for a user
   * @param userAddress - User address
   * @returns Permission usage statistics
   */
  async getPermissionStats(userAddress: string): Promise<{
    totalGrants: number;
    activeGrants: number;
    totalApps: number;
    totalScopes: number;
    recentActivity: number;
  }> {
    const grants = await this.getGrantsByUser(userAddress);
    const now = Date.now();
    
    const activeGrants = grants.filter((g) => !g.expiresAt || g.expiresAt > now);
    const uniqueApps = new Set(grants.map((g) => g.requestingWallet));
    const uniqueScopes = new Set(grants.flatMap((g) => g.scopes));
    
    const recentActivity =
      grants.length > 0 ? Math.max(...grants.map((g) => g.expiresAt || 0)) : 0;

    return {
      totalGrants: grants.length,
      activeGrants: activeGrants.length,
      totalApps: uniqueApps.size,
      totalScopes: uniqueScopes.size,
      recentActivity
    };
  }

  /**
   * Clean up expired permissions
   * @param userAddress - User address
   * @returns Number of permissions cleaned up
   */
  async cleanupExpiredPermissions(userAddress: string): Promise<number> {
    const now = Date.now();
    const grants = await this.getGrantsByUser(userAddress);

    return grants.filter((grant) => {
      if (!grant.expiresAt || grant.expiresAt === 0) {
        return false;
      }
      return grant.expiresAt <= now;
    }).length;
  }

  private buildGrantFromPermissions(
    requestingWallet: string,
    targetWallet: string,
    permissions: WalletAllowlistPermission[],
  ): AccessGrant | undefined {
    const grants = this.convertPermissionsToGrants(permissions);
    return grants.find(
      (candidate) =>
        candidate.requestingWallet === requestingWallet &&
        candidate.targetWallet === targetWallet,
    );
  }

  private convertPermissionsToGrants(
    permissions: WalletAllowlistPermission[],
  ): AccessGrant[] {
    const grouped = new Map<string, WalletAllowlistPermission[]>();

    for (const permission of permissions) {
      const key = `${permission.requestingWallet}-${permission.targetWallet}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.push(permission);
      } else {
        grouped.set(key, [permission]);
      }
    }

    const grants: AccessGrant[] = [];
    for (const entries of grouped.values()) {
      if (entries.length === 0) {
        continue;
      }

      const [first] = entries;
      const scopes = new Set<PermissionScope>();
      let earliestGrantedAt = entries[0].grantedAt;
      let expiresAtCandidate = 0;

      for (const entry of entries) {
        scopes.add(this.toPermissionScope(entry.scope));
        if (entry.grantedAt < earliestGrantedAt) {
          earliestGrantedAt = entry.grantedAt;
        }
        if (entry.expiresAt > expiresAtCandidate) {
          expiresAtCandidate = entry.expiresAt;
        }
      }

      const grant: AccessGrant = {
        id: `grant_${first.requestingWallet}_${first.targetWallet}_${earliestGrantedAt}`,
        requestingWallet: first.requestingWallet,
        targetWallet: first.targetWallet,
        scopes: Array.from(scopes),
        grantedAt: earliestGrantedAt,
      };

      if (expiresAtCandidate > 0) {
        grant.expiresAt = expiresAtCandidate;
      }

      grants.push(grant);
    }

    return grants;
  }

  private toPermissionScope(scope: string): PermissionScope {
    return scope as PermissionScope;
  }

  private async persistConsentRequest(record: ConsentRequestRecord): Promise<void> {
    if (this.consentRepository) {
      await this.consentRepository.save(record);
    } else {
      this.pendingConsents.set(record.requestId, { ...record });
    }
  }

  /**
   * Swap the consent persistence backend at runtime.
   * Useful for applications that want to wire a custom repository after
   * the service has been constructed (e.g., demos supplying a filesystem store).
   */
  setConsentRepository(repository?: ConsentRepository): void {
    this.consentRepository = repository;
  }

  private async updateConsentStatus(params: {
    requesterWallet: string;
    targetWallet: string;
    newStatus: ConsentStatus;
    updatedAt: number;
    requestId?: string;
  }): Promise<void> {
    const normalizedRequester = normalizeSuiAddress(params.requesterWallet);
    const normalizedTarget = normalizeSuiAddress(params.targetWallet);

    if (this.consentRepository) {
      if (params.requestId) {
        await this.consentRepository.updateStatus(params.requestId, params.newStatus, params.updatedAt);
      } else {
        const pendingRecords = await this.consentRepository.listByTarget(normalizedTarget, 'pending');
        await Promise.all(
          pendingRecords
            .filter((record) => record.requesterWallet === normalizedRequester)
            .map((record) =>
              this.consentRepository!.updateStatus(record.requestId, params.newStatus, params.updatedAt),
            ),
        );
      }
    }

    for (const [requestId, record] of this.pendingConsents.entries()) {
      if (record.requesterWallet === normalizedRequester && record.targetWallet === normalizedTarget) {
        const updatedRecord: ConsentRequestRecord = {
          ...record,
          status: params.newStatus,
          updatedAt: params.updatedAt,
        };
        this.pendingConsents.set(requestId, updatedRecord);
      }
    }
  }
}