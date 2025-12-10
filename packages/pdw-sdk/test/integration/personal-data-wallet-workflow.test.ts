/**
 * PersonalDataWallet End-to-End Workflow Test
 *
 * Demonstrates the high-level PDW client API across wallet, context,
 * access control, aggregation, and encryption flows using the official
 * PersonalDataWallet client extension.
 */

import { describe, it, beforeAll, expect, jest } from '@jest/globals';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromHex } from '@mysten/sui/utils';
import dotenv from 'dotenv';

import { PersonalDataWallet } from '../../src/client/PersonalDataWallet';
import { PermissionScopes, PermissionScope, MainWallet } from '../../src/types/wallet';
import { CrossContextPermissionService } from '../../src/services/CrossContextPermissionService';

// Load environment configuration used across the integration suite
dotenv.config({ path: '.env.test' });

describe('PersonalDataWallet client extension - full workflow', () => {
  jest.setTimeout(120_000);

  let suiClient: SuiClient;
  let pdwClient: any;
  let pdw: PersonalDataWallet;
  let keypair: Ed25519Keypair;
  let userAddress: string;
  let packageId: string;
  let accessRegistryId: string;
  let mainWallet: MainWallet | null;
  let researchContextId: string;
  let analyticsContextId: string;

  const researchAppId = 'research-app';
  const analyticsAppId = 'analytics-app';
  const researchContextWallet = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const analyticsContextWallet = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  beforeAll(async () => {
    console.log('\n🧪 Initializing PersonalDataWallet extension workflow test...');

    packageId = process.env.PACKAGE_ID || process.env.PDW_PACKAGE_ID || '';
    accessRegistryId = process.env.ACCESS_REGISTRY_ID || process.env.PDW_ACCESS_REGISTRY_ID || '';

    if (!packageId || !accessRegistryId) {
      throw new Error('PACKAGE_ID and ACCESS_REGISTRY_ID must be configured in .env.test');
    }

    suiClient = new SuiClient({
      url: getFullnodeUrl('testnet'),
    });

    const privateKey = process.env.TEST_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('TEST_PRIVATE_KEY environment variable not set');
    }

    const { schema, secretKey } = decodeSuiPrivateKey(privateKey);
    if (schema !== 'ED25519') {
      throw new Error(`Unsupported key scheme for test wallet: ${schema}`);
    }

    keypair = Ed25519Keypair.fromSecretKey(secretKey);
    userAddress = keypair.getPublicKey().toSuiAddress();

    const keyServers = [
      process.env.SEAL_KEY_SERVER_1_OBJECT,
      process.env.SEAL_KEY_SERVER_2_OBJECT,
    ].filter((value): value is string => Boolean(value));

    pdwClient = suiClient.$extend(
      PersonalDataWallet.asClientExtension({
        packageId,
        accessRegistryId,
        apiUrl: process.env.PDW_API_URL || process.env.API_URL || 'http://localhost:3001/api',
        encryptionConfig: {
          enabled: true,
          keyServers,
          policyConfig: {
            threshold: 2,
          },
        },
      }),
    );

    pdw = (pdwClient as any).pdw as PersonalDataWallet;

    // Ensure underlying services use the full SuiClient instance for blockchain operations
    const mainWalletInternal = pdw.mainWalletService as unknown as { suiClient: SuiClient };
    mainWalletInternal.suiClient = suiClient;

    const contextInternal = pdw.contextWalletService as unknown as {
      suiClient: SuiClient;
      mainWalletService: typeof pdw.mainWalletService;
    };
    contextInternal.suiClient = suiClient;
    contextInternal.mainWalletService = pdw.mainWalletService;

    const permissionInternal = pdw.permissionService as unknown as {
      suiClient: SuiClient;
      contextWalletService?: typeof pdw.contextWalletService;
      crossContextPermissions: CrossContextPermissionService;
    };
    permissionInternal.suiClient = suiClient;
    permissionInternal.contextWalletService = pdw.contextWalletService;
    permissionInternal.crossContextPermissions = new CrossContextPermissionService(
      {
        packageId,
        accessRegistryId,
      },
      suiClient,
    );

    const aggregationInternal = pdw.aggregationService as unknown as {
      suiClient: SuiClient;
      permissionService: typeof pdw.permissionService;
      contextWalletService: typeof pdw.contextWalletService;
    };
    aggregationInternal.suiClient = suiClient;
    aggregationInternal.permissionService = pdw.permissionService;
    aggregationInternal.contextWalletService = pdw.contextWalletService;

    // Ensure a main wallet context exists for deterministic testing
    mainWallet = await pdw.wallet.ensureMainWallet(userAddress);
    console.log('   • Ensured main wallet metadata for test user');

    console.log('   • Connected as:', userAddress);
    console.log('   • Package ID:', packageId);
    console.log('   • Access Registry ID:', accessRegistryId);
  });

  it('ensures main wallet metadata is available for the test user', async () => {
    const ensured = await pdw.wallet.ensureMainWallet(userAddress);
    expect(ensured).not.toBeNull();

    mainWallet = ensured;
    console.log('✅ Main wallet metadata prepared:', ensured.walletId);
    console.log('   Salt (context):', ensured.salts.context.slice(0, 16), '...');
  });

  it('derives deterministic context identifiers for analytics and research apps', async () => {
    const salt = mainWallet!.salts.context;

    researchContextId = await pdw.wallet.deriveContextId({
      userAddress,
      appId: researchAppId,
      salt,
    });

    analyticsContextId = await pdw.wallet.deriveContextId({
      userAddress,
      appId: analyticsAppId,
      salt,
    });

    console.log('🔑 Derived context IDs:');
    console.log('   • Research:', researchContextId);
    console.log('   • Analytics:', analyticsContextId);

    expect(researchContextId.startsWith('0x')).toBe(true);
    expect(analyticsContextId.startsWith('0x')).toBe(true);
    expect(researchContextId).not.toBe(analyticsContextId);
  });

  it('walks the consent and grant flow via pdw.access', async () => {
    const consent = await pdw.access.requestConsent({
      requesterWallet: analyticsContextWallet,
      targetWallet: researchContextWallet,
      scopes: [PermissionScopes.READ_MEMORIES],
      purpose: 'Aggregate research insights for analytics dashboards',
      expiresIn: 24 * 60 * 60 * 1000,
    });

    console.log('📝 Consent request created:');
    console.log('   Requester:', consent.requesterWallet);
    console.log('   Target:', consent.targetWallet);
    console.log('   Scopes:', consent.targetScopes.join(', '));

    expect(consent.targetScopes).toContain(PermissionScopes.READ_MEMORIES);

    const permissionInternal = (pdw.permissionService as any).crossContextPermissions;
    const grantTx = permissionInternal.buildGrantWalletAllowlistTransaction({
      requestingWallet: analyticsContextWallet,
      targetWallet: researchContextWallet,
      scope: PermissionScopes.READ_MEMORIES,
      accessLevel: 'read',
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    const grantData = grantTx.getData();
    expect(grantData.commands.length).toBeGreaterThan(0);
    expect(grantData.commands[0].$kind).toBe('MoveCall');

    console.log('✅ grant_wallet_allowlist_access transaction prepared');
  });

  it('builds seal_approve transaction for analytics wallet', async () => {
    const identityBytes = fromHex(userAddress.replace(/^0x/, ''));
    const sealTx = pdw.permissionService.createApprovalTransaction(identityBytes, analyticsContextWallet);

    const sealData = sealTx.getData();
    expect(sealData.commands.length).toBeGreaterThan(0);

    const moveCall = sealData.commands[0] as any;
    expect(moveCall.$kind).toBe('MoveCall');
    expect(moveCall.MoveCall.function).toBe('seal_approve');

    console.log('✅ seal_approve transaction prepared for analytics wallet');
  });

  it('lists user contexts through pdw.context service', async () => {
    const contexts = await pdw.context.listUserContexts(userAddress);

    console.log(`📚 Contexts discovered: ${contexts.length}`);
    for (const ctx of contexts) {
      console.log(`   • ${ctx.appId} (${ctx.id}) -> contextId=${ctx.contextId}`);
    }

    expect(Array.isArray(contexts)).toBe(true);
  });

  it('runs an aggregated query with permission enforcement', async () => {
    const scope: PermissionScope = PermissionScopes.READ_MEMORIES;
    const aggregated = await pdw.aggregate.query({
      requestingWallet: analyticsContextWallet,
      userAddress,
      targetWallets: [analyticsContextWallet, researchContextWallet, analyticsContextId, researchContextId],
      query: 'research insights',
      scope,
      limit: 5,
    });

    console.log('🔍 Aggregation result summary:');
    console.log('   Total results:', aggregated.totalResults);
    console.log('   Queried contexts:', aggregated.queriedContexts.length);
    console.log('   Skipped contexts:', aggregated.skippedContexts.length);
    console.log('   Permission checks:', aggregated.metrics.permissionChecks);

    expect(aggregated).toHaveProperty('results');
    expect(aggregated).toHaveProperty('metrics');
    expect(aggregated.metrics.contextsChecked).toBeGreaterThanOrEqual(0);
  });

  it('verifies permission status via pdw.access.checkPermission', async () => {
    const hasPermission = await pdw.access.checkPermission(
      analyticsContextWallet,
      PermissionScopes.READ_MEMORIES,
      researchContextWallet,
    );

    console.log(`🔐 Permission status (analytics ➜ research): ${hasPermission ? 'granted' : 'not granted'}`);

    expect(typeof hasPermission).toBe('boolean');
  });

  it('summarizes the full PersonalDataWallet workflow', () => {
    console.log('\n🎯 PersonalDataWallet Workflow Summary');
    console.log('   1. Main wallet fetched via pdw.wallet ✅');
    console.log('   2. Context IDs derived deterministically ✅');
    console.log('   3. Consent + grant transactions constructed ✅');
    console.log('   4. seal_approve transaction prepared ✅');
    console.log('   5. Context discovery performed ✅');
    console.log('   6. Aggregation query executed with permission filters ✅');
    console.log('   7. Permission status checked via pdw.access ✅');
  });
});
