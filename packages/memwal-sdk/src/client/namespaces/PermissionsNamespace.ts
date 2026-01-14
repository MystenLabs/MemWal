/**
 * Permissions Namespace - OAuth-style Access Control
 *
 * Pure delegation to PermissionService for access management.
 * Handles consent requests, grants, revocation, and validation.
 *
 * @module client/namespaces
 */

import type { ServiceContainer } from '../SimplePDWClient';
import type {
  ConsentRequestRecord,
  AccessGrant,
  PermissionScope
} from '../../core/types/wallet';

/**
 * Consent request options
 */
export interface ConsentRequestOptions {
  appId: string;
  scopes: PermissionScope[];
  purpose: string;
  expiresIn?: number; // milliseconds
}

/**
 * Grant options
 */
export interface GrantOptions {
  appId: string;
  scopes: PermissionScope[];
  expiresAt?: number; // timestamp
}

/**
 * Permissions Namespace
 *
 * Handles OAuth-style access control and consent management
 */
export class PermissionsNamespace {
  constructor(private services: ServiceContainer) {}

  /**
   * Request user consent for data access
   *
   * Delegates to: PermissionService.requestConsent()
   *
   * @param appId - Application identifier
   * @param scopes - Requested permission scopes
   * @param purpose - Purpose description
   * @returns Consent request record
   */
  async request(
    appId: string,
    scopes: PermissionScope[],
    purpose: string
  ): Promise<ConsentRequestRecord> {
    if (!this.services.permissions) {
      throw new Error('Permission service not configured.');
    }

    return await this.services.permissions.requestConsent({
      requesterWallet: appId,
      targetWallet: this.services.config.userAddress,
      scopes,
      purpose
    });
  }

  /**
   * Grant permissions to an app
   *
   * Delegates to: PermissionService.grantPermissions()
   *
   * @param appId - Application to grant access
   * @param scopes - Scopes to grant
   * @param expiresAt - Optional expiration timestamp
   * @returns Access grant record
   */
  async grant(
    appId: string,
    scopes: PermissionScope[],
    expiresAt?: number
  ): Promise<AccessGrant> {
    if (!this.services.permissions) {
      throw new Error('Permission service not configured.');
    }

    return await this.services.permissions.grantPermissions(
      this.services.config.userAddress,
      {
        requestingWallet: appId,
        targetWallet: this.services.config.userAddress,
        scopes,
        expiresAt,
        signer: this.services.config.signer.getSigner()
      }
    );
  }

  /**
   * Revoke permission scope from an app
   *
   * Delegates to: PermissionService.revokePermissions()
   *
   * @param appId - Application to revoke from
   * @param scope - Scope to revoke
   * @returns Success status
   */
  async revoke(appId: string, scope: PermissionScope): Promise<boolean> {
    if (!this.services.permissions) {
      throw new Error('Permission service not configured.');
    }

    return await this.services.permissions.revokePermissions(
      this.services.config.userAddress,
      {
        requestingWallet: appId,
        targetWallet: this.services.config.userAddress,
        scope,
        signer: this.services.config.signer.getSigner()
      }
    );
  }

  /**
   * Check if app has specific permission
   *
   * Delegates to: PermissionService.checkPermission()
   *
   * @param appId - Application to check
   * @param scope - Scope to check
   * @returns True if permission exists and valid
   */
  async check(appId: string, scope: PermissionScope): Promise<boolean> {
    if (!this.services.permissions) {
      throw new Error('Permission service not configured.');
    }

    // checkPermission takes (appId, scope, targetWallet)
    return await this.services.permissions.checkPermission(
      appId,
      scope,
      this.services.config.userAddress
    );
  }

  /**
   * List all permission grants for the current user
   *
   * Queries on-chain allowlist for permissions using event-based state reconstruction.
   * Returns only active (non-expired) grants.
   *
   * @returns Array of active grants
   */
  async list(): Promise<AccessGrant[]> {
    if (!this.services.permissions) {
      throw new Error('Permission service not configured.');
    }

    // Use existing method that queries events and reduces to current state
    const grants = await this.services.permissions.getGrantsByUser(
      this.services.config.userAddress
    );

    // Filter for active (non-expired) grants
    const now = Date.now();
    return grants.filter(g => !g.expiresAt || g.expiresAt > now);
  }

  /**
   * Get pending consent requests
   *
   * Delegates to: PermissionService.getPendingConsents()
   *
   * @returns Array of pending consent requests
   */
  async getPendingConsents(): Promise<ConsentRequestRecord[]> {
    if (!this.services.permissions) {
      throw new Error('Permission service not configured.');
    }

    const consents = await this.services.permissions.getPendingConsents(
      this.services.config.userAddress
    );

    // Convert ConsentRequest[] to ConsentRequestRecord[]
    return consents.map(c => ({
      ...c,
      requestId: c.requestId || `req_${Date.now()}`,
      createdAt: c.createdAt || Date.now(),
      updatedAt: c.updatedAt || Date.now(),
      status: c.status || 'pending'
    })) as ConsentRequestRecord[];
  }

  /**
   * Approve a consent request
   *
   * Delegates to: PermissionService.approveConsent()
   *
   * @param consentId - Consent request ID
   * @returns Access grant
   */
  async approve(consentId: string): Promise<AccessGrant> {
    if (!this.services.permissions) {
      throw new Error('Permission service not configured.');
    }

    // Get the consent request first
    const consents = await this.getPendingConsents();
    const consent = consents.find(c => c.requestId === consentId);

    if (!consent) {
      throw new Error(`Consent request ${consentId} not found`);
    }

    // approveConsent takes (userAddress, consentRequest, contextId)
    return await this.services.permissions.approveConsent(
      this.services.config.userAddress,
      consent as any,
      consent.targetWallet
    );
  }

  /**
   * Deny a consent request
   *
   * Delegates to: PermissionService.denyConsent()
   *
   * @param consentId - Consent request ID
   * @returns Success status
   */
  async deny(consentId: string): Promise<boolean> {
    if (!this.services.permissions) {
      throw new Error('Permission service not configured.');
    }

    // Get the consent request first
    const consents = await this.getPendingConsents();
    const consent = consents.find(c => c.requestId === consentId);

    if (!consent) {
      throw new Error(`Consent request ${consentId} not found`);
    }

    // denyConsent takes (userAddress, consentRequest)
    return await this.services.permissions.denyConsent(
      this.services.config.userAddress,
      consent as any
    );
  }
}
