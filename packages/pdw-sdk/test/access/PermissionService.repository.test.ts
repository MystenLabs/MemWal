import { describe, it, expect, beforeEach } from '@jest/globals';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { Transaction } from '@mysten/sui/transactions';

import { PermissionService } from '../../src/access/PermissionService';
import { InMemoryConsentRepository } from '../../src/permissions/ConsentRepository';
import type {
  GrantWalletAllowlistOptions,
  WalletAllowlistPermission,
  WalletAllowlistHistoryEvent,
  WalletAllowlistHistoryFilter,
  RevokeWalletAllowlistOptions,
  CrossContextPermissionService,
} from '../../src/services/CrossContextPermissionService';
import type { PermissionScope, ConsentRequest } from '../../src/types/wallet';

class FakeCrossContextPermissionService {
  private permissions: WalletAllowlistPermission[] = [];
  private history: WalletAllowlistHistoryEvent[] = [];

  setHistory(events: WalletAllowlistHistoryEvent[]) {
    this.history = events;
  }

  async grantWalletAllowlistAccess(options: GrantWalletAllowlistOptions): Promise<string> {
    const now = Date.now();
    this.permissions.push({
      requestingWallet: options.requestingWallet,
      targetWallet: options.targetWallet,
      scope: options.scope ?? 'read',
      accessLevel: options.accessLevel,
      grantedAt: now,
      expiresAt: options.expiresAt,
      grantedBy: options.requestingWallet,
    });
    return 'digest';
  }

  async queryWalletPermissions(params: {
    requestingWallet?: string;
    targetWallet?: string;
    scope?: string;
  }): Promise<WalletAllowlistPermission[]> {
    return this.permissions.filter((permission) => {
      if (params.requestingWallet && permission.requestingWallet !== params.requestingWallet) {
        return false;
      }
      if (params.targetWallet && permission.targetWallet !== params.targetWallet) {
        return false;
      }
      if (params.scope && permission.scope !== params.scope) {
        return false;
      }
      return true;
    });
  }

  async listGrantsByTarget(targetWallet: string): Promise<WalletAllowlistPermission[]> {
    return this.permissions.filter((permission) => permission.targetWallet === targetWallet);
  }

  async hasWalletPermission(params: {
    requestingWallet: string;
    targetWallet?: string;
    scope?: string;
  }): Promise<boolean> {
    return (await this.queryWalletPermissions(params)).length > 0;
  }

  async revokeWalletAllowlistAccess(options: RevokeWalletAllowlistOptions): Promise<string> {
    this.permissions = this.permissions.filter(
      (permission) =>
        !(
          permission.requestingWallet === options.requestingWallet &&
          permission.targetWallet === options.targetWallet &&
          (!options.scope || permission.scope === options.scope)
        ),
    );
    return 'revoked';
  }

  buildSealApproveTransaction(contentId: Uint8Array, requestingWallet: string): Transaction {
    return new Transaction();
  }

  async getWalletAllowlistHistory(
    filter?: WalletAllowlistHistoryFilter,
  ): Promise<WalletAllowlistHistoryEvent[]> {
    return this.history.filter((event) => {
      if (filter?.requestingWallet && event.requestingWallet !== filter.requestingWallet) {
        return false;
      }
      if (filter?.targetWallet && event.targetWallet !== filter.targetWallet) {
        return false;
      }
      return true;
    });
  }
}

describe('PermissionService with consent repository', () => {
  const suiClient = new SuiClient({ url: getFullnodeUrl('testnet') });
  const PACKAGE_ID = '0x1';
  const ACCESS_REGISTRY_ID = '0x2';

  let repository: InMemoryConsentRepository;
  let service: PermissionService;
  let crossContext: FakeCrossContextPermissionService;

  beforeEach(() => {
    repository = new InMemoryConsentRepository();
    crossContext = new FakeCrossContextPermissionService();
    service = new PermissionService({
      suiClient,
      packageId: PACKAGE_ID,
      accessRegistryId: ACCESS_REGISTRY_ID,
      consentRepository: repository,
      crossContextPermissionService: crossContext as unknown as CrossContextPermissionService,
    });
  });

  it('persists consent requests via repository', async () => {
    const consent = await service.requestConsent({
      requesterWallet: '0xabc0000000000000000000000000000000000001',
      targetWallet: '0xabc0000000000000000000000000000000000002',
      scopes: ['read:memories'],
      purpose: 'Unit test',
    });

    const stored = await repository.listByTarget(consent.targetWallet, 'pending');
    expect(stored).toHaveLength(1);
    expect(stored[0].requestId).toBe(consent.requestId);
  });

  it('updates consent status when approved', async () => {
    const consent = await service.requestConsent({
      requesterWallet: '0xabc0000000000000000000000000000000000003',
      targetWallet: '0xabc0000000000000000000000000000000000004',
      scopes: ['write:memories' as PermissionScope],
      purpose: 'Approve path',
    });

    await service.approveConsent(consent.targetWallet, consent, 'context-id');

    const approved = await repository.listByTarget(consent.targetWallet, 'approved');
    expect(approved).toHaveLength(1);
    expect(approved[0].status).toBe('approved');
  });

  it('stores denied consent when requestId missing', async () => {
    const consent: ConsentRequest = {
      requesterWallet: '0xabc0000000000000000000000000000000000005',
      targetWallet: '0xabc0000000000000000000000000000000000006',
      targetScopes: ['read:contexts'],
      purpose: 'Denied path',
      expiresAt: undefined,
    };

    await service.denyConsent(consent.targetWallet, consent);

    const denied = await repository.listByTarget(consent.targetWallet, 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0].status).toBe('denied');
  });

  it('reports audit combining repository and history', async () => {
    const targetWallet = '0xabc0000000000000000000000000000000000007';
    const normalizedTarget = normalizeSuiAddress(targetWallet);
    const normalizedRequester = normalizeSuiAddress('0xabc0000000000000000000000000000000000008');
    await service.requestConsent({
      requesterWallet: normalizedRequester,
      targetWallet: normalizedTarget,
      scopes: ['read:memories'],
      purpose: 'Audit path',
    });

    const historyTimestamp = Date.now() + 1000;
    crossContext.setHistory([
      {
        timestamp: historyTimestamp,
        action: 'grant',
        requestingWallet: normalizedRequester,
        targetWallet: normalizedTarget,
        scope: 'read:memories',
        accessLevel: 'read',
        expiresAt: 0,
        grantedBy: normalizedRequester,
      },
    ]);

    const audit = await service.getPermissionAudit(normalizedTarget);
    expect(audit.map((entry) => entry.action)).toEqual(['request', 'grant']);
    expect(audit[0].timestamp).toBeLessThan(audit[1].timestamp);
  });
});
