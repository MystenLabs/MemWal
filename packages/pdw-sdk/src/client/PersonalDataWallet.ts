/**
 * PersonalDataWallet Client Extension
 * 
 * Main client extension that follows MystenLabs patterns for Sui ecosystem SDKs.
 * Provides a composable API for memory management, chat, storage, and encryption.
 */

import type { ClientWithCoreApi, PDWConfig } from '../types';
import { MemoryService } from '../services/MemoryService';
import { StorageService } from '../services/StorageService';
import { EncryptionService } from '../services/EncryptionService';
import { TransactionService } from '../services/TransactionService';
import { ViewService } from '../view/ViewService';
import { MainWalletService } from '../wallet/MainWalletService';
import { ContextWalletService } from '../wallet/ContextWalletService';
import { PermissionService } from '../access/PermissionService';
import { AggregationService } from '../aggregation/AggregationService';
import { createDefaultConfig } from '../config/defaults';
import { validateConfig } from '../config/validation';
import type { ConsentRepository } from '../permissions/ConsentRepository';

// BCS types from generated contracts (ESM static imports)
import * as memoryBcsTypes from '../generated/pdw/memory';
import * as capabilityBcsTypes from '../generated/pdw/capability';
import * as walletBcsTypes from '../generated/pdw/wallet';

export interface PersonalDataWalletExtension {
  // Top-level imperative methods
  setConsentRepository: (repository?: ConsentRepository) => void;
  
  // Storage methods
  uploadToStorage: StorageService['upload'];
  retrieveFromStorage: StorageService['retrieve'];
  
  // Organized service methods
  tx: {
    createMemoryRecord: TransactionService['buildCreateMemoryRecord'];
    updateMemoryMetadata: TransactionService['buildUpdateMemoryMetadata'];
    deleteMemoryRecord: TransactionService['buildDeleteMemoryRecord'];
    grantAccess: TransactionService['buildGrantAccess'];
    revokeAccess: TransactionService['buildRevokeAccess'];
    registerContent: TransactionService['buildRegisterContent'];
    executeBatch: TransactionService['executeBatch'];
  };
  
  call: {
    createMemoryRecord: TransactionService['createMemoryRecord'];
    updateMemoryMetadata: TransactionService['updateMemoryMetadata'];
    deleteMemoryRecord: TransactionService['deleteMemoryRecord'];
    grantAccess: TransactionService['grantAccess'];
    revokeAccess: TransactionService['revokeAccess'];
    executeBatch: TransactionService['executeBatch'];
  };
  
  view: {
    getUserMemories: ViewService['getUserMemories'];
    getMemoryIndex: ViewService['getMemoryIndex'];
    getMemory: ViewService['getMemory'];
    getMemoryStats: ViewService['getMemoryStats'];
    getAccessPermissions: ViewService['getAccessPermissions'];
    getContentRegistry: ViewService['getContentRegistry'];
    objectExists: ViewService['objectExists'];
    getObjectType: ViewService['getObjectType'];
    findMemoryByContentHash: ViewService['findMemoryByContentHash'];
  };

  // Wallet architecture services
  wallet: {
    getMainWallet: MainWalletService['getMainWallet'];
    createMainWallet: MainWalletService['createMainWallet'];
    deriveContextId: MainWalletService['deriveContextId'];
    rotateKeys: MainWalletService['rotateKeys'];
    ensureMainWallet: MainWalletService['ensureMainWallet'];
  };

  context: {
    create: ContextWalletService['create'];
    getContext: ContextWalletService['getContext'];
    listUserContexts: ContextWalletService['listUserContexts'];
    addData: ContextWalletService['addData'];
    removeData: ContextWalletService['removeData'];
    listData: ContextWalletService['listData'];
    ensureContext: ContextWalletService['ensureContext'];
  };

  access: {
    requestConsent: PermissionService['requestConsent'];
    grantPermissions: PermissionService['grantPermissions'];
    revokePermissions: PermissionService['revokePermissions'];
    checkPermission: PermissionService['checkPermission'];
    getGrantsByUser: PermissionService['getGrantsByUser'];
    validateOAuthPermission: PermissionService['validateOAuthPermission'];
  };

  aggregate: {
    query: AggregationService['query'];
    queryWithScopes: AggregationService['queryWithScopes'];
    search: AggregationService['search'];
    getAggregatedStats: AggregationService['getAggregatedStats'];
  };
  
  bcs: {
    // Will be populated by generated types from @mysten/codegen
    Memory: () => any;
    MemoryIndex: () => any;
    MemoryMetadata: () => any;
    AccessControl: () => any;
  };
  
  // Service instances for advanced usage
  memory: MemoryService;
  storage: StorageService;
  encryption: EncryptionService;
  viewService: ViewService;
  mainWalletService: MainWalletService;
  contextWalletService: ContextWalletService;
  permissionService: PermissionService;
  aggregationService: AggregationService;
  
  // Configuration
  config: PDWConfig;
}

export class PersonalDataWallet {
  #client: ClientWithCoreApi;
  #config: PDWConfig;
  #transactions: TransactionService;
  #view: ViewService;
  #memory: MemoryService;
  #storage: StorageService;
  #encryption: EncryptionService;
  #mainWallet: MainWalletService;
  #contextWallet: ContextWalletService;
  #permission: PermissionService;
  #aggregation: AggregationService;

  constructor(client: ClientWithCoreApi, config?: Partial<PDWConfig>) {
    this.#client = client;
    this.#config = validateConfig({ ...createDefaultConfig(), ...config });

    // Initialize services
    this.#transactions = new TransactionService(client as any, this.#config);
    this.#view = new ViewService(client, this.#config);
    this.#memory = new MemoryService(client, this.#config);
    this.#storage = new StorageService(this.#config);
    this.#encryption = new EncryptionService(client, this.#config);
    
    // Initialize wallet architecture services
    this.#mainWallet = new MainWalletService({
      suiClient: (client as any).client || client,
      packageId: this.#config.packageId || ''
    });
    
    this.#contextWallet = new ContextWalletService({
      suiClient: (client as any).client || client,
      packageId: this.#config.packageId || '',
      mainWalletService: this.#mainWallet,
      storageService: this.#storage,
      encryptionService: this.#encryption
    });
    
    this.#permission = new PermissionService({
      suiClient: (client as any).client || client,
      packageId: this.#config.packageId || '',
      accessRegistryId: this.#config.accessRegistryId || '',
      contextWalletService: this.#contextWallet
    });
    
    this.#aggregation = new AggregationService({
      suiClient: (client as any).client || client,
      packageId: this.#config.packageId || '',
      permissionService: this.#permission,
      contextWalletService: this.#contextWallet
    });
    
    // Bind methods after services are initialized
    this.uploadToStorage = this.#storage.upload.bind(this.#storage);
    this.retrieveFromStorage = this.#storage.retrieve.bind(this.#storage);
  }

  // Top-level imperative methods (declarations)
  uploadToStorage: StorageService['upload'];
  retrieveFromStorage: StorageService['retrieve'];
  setConsentRepository(repository?: ConsentRepository): void {
    this.#permission.setConsentRepository(repository);
  }

  // Transaction builders
  get tx() {
    return {
      createMemoryRecord: this.#transactions.buildCreateMemoryRecord.bind(this.#transactions),
      updateMemoryMetadata: this.#transactions.buildUpdateMemoryMetadata.bind(this.#transactions),
      deleteMemoryRecord: this.#transactions.buildDeleteMemoryRecord.bind(this.#transactions),
      grantAccess: this.#transactions.buildGrantAccess.bind(this.#transactions),
      revokeAccess: this.#transactions.buildRevokeAccess.bind(this.#transactions),
      registerContent: this.#transactions.buildRegisterContent.bind(this.#transactions),
      executeBatch: this.#transactions.executeBatch.bind(this.#transactions),
    };
  }

  // Transaction execution (async thunks)
  get call() {
    return {
      createMemoryRecord: this.#transactions.createMemoryRecord.bind(this.#transactions),
      updateMemoryMetadata: this.#transactions.updateMemoryMetadata.bind(this.#transactions),
      deleteMemoryRecord: this.#transactions.deleteMemoryRecord.bind(this.#transactions),
      grantAccess: this.#transactions.grantAccess.bind(this.#transactions),
      revokeAccess: this.#transactions.revokeAccess.bind(this.#transactions),
      executeBatch: this.#transactions.executeBatch.bind(this.#transactions),
    };
  }

  // View methods
  get view() {
    return {
      getUserMemories: this.#view.getUserMemories.bind(this.#view),
      getMemoryIndex: this.#view.getMemoryIndex.bind(this.#view),
      getMemory: this.#view.getMemory.bind(this.#view),
      getMemoryStats: this.#view.getMemoryStats.bind(this.#view),
      getStorageStats: this.#storage.getStats.bind(this.#storage),
      listStoredItems: this.#storage.list.bind(this.#storage),
      getAccessPermissions: this.#view.getAccessPermissions.bind(this.#view),
      getContentRegistry: this.#view.getContentRegistry.bind(this.#view),
      objectExists: this.#view.objectExists.bind(this.#view),
      getObjectType: this.#view.getObjectType.bind(this.#view),
      findMemoryByContentHash: this.#view.findMemoryByContentHash.bind(this.#view),
    };
  }

  // BCS types from generated contracts (using static ESM imports)
  get bcs() {
    return {
      // Memory types
      Memory: memoryBcsTypes.Memory,
      MemoryIndex: memoryBcsTypes.MemoryIndex,
      MemoryMetadata: memoryBcsTypes.MemoryMetadata,
      MemoryCreated: memoryBcsTypes.MemoryCreated,
      MemoryIndexUpdated: memoryBcsTypes.MemoryIndexUpdated,
      MemoryMetadataUpdated: memoryBcsTypes.MemoryMetadataUpdated,
      MemoryUpdated: memoryBcsTypes.MemoryUpdated,

      // Capability types
      MemoryCap: capabilityBcsTypes.MemoryCap,
      MemoryCapCreated: capabilityBcsTypes.MemoryCapCreated,

      // Wallet types
      ...walletBcsTypes,
    };
  }

  // Wallet architecture service getters
  get wallet() {
    return {
      getMainWallet: this.#mainWallet.getMainWallet.bind(this.#mainWallet),
      createMainWallet: this.#mainWallet.createMainWallet.bind(this.#mainWallet),
      deriveContextId: this.#mainWallet.deriveContextId.bind(this.#mainWallet),
      rotateKeys: this.#mainWallet.rotateKeys.bind(this.#mainWallet),
      ensureMainWallet: this.#mainWallet.ensureMainWallet.bind(this.#mainWallet),
    };
  }

  get context() {
    return {
      create: this.#contextWallet.create.bind(this.#contextWallet),
      getContext: this.#contextWallet.getContext.bind(this.#contextWallet),
      listUserContexts: this.#contextWallet.listUserContexts.bind(this.#contextWallet),
      addData: this.#contextWallet.addData.bind(this.#contextWallet),
      removeData: this.#contextWallet.removeData.bind(this.#contextWallet),
      listData: this.#contextWallet.listData.bind(this.#contextWallet),
      ensureContext: this.#contextWallet.ensureContext.bind(this.#contextWallet),
    };
  }

  get access() {
    return {
      requestConsent: this.#permission.requestConsent.bind(this.#permission),
      grantPermissions: this.#permission.grantPermissions.bind(this.#permission),
      revokePermissions: this.#permission.revokePermissions.bind(this.#permission),
      checkPermission: this.#permission.checkPermission.bind(this.#permission),
      getGrantsByUser: this.#permission.getGrantsByUser.bind(this.#permission),
      validateOAuthPermission: this.#permission.validateOAuthPermission.bind(this.#permission),
    };
  }

  get aggregate() {
    return {
      query: this.#aggregation.query.bind(this.#aggregation),
      queryWithScopes: this.#aggregation.queryWithScopes.bind(this.#aggregation),
      search: this.#aggregation.search.bind(this.#aggregation),
      getAggregatedStats: this.#aggregation.getAggregatedStats.bind(this.#aggregation),
    };
  }

  // Service instances
  get memory() { return this.#memory; }
  get storage() { return this.#storage; }
  get encryption() { return this.#encryption; }
  get config() { return this.#config; }
  get viewService() { return this.#view; }
  get mainWalletService() { return this.#mainWallet; }
  get contextWalletService() { return this.#contextWallet; }
  get permissionService() { return this.#permission; }
  get aggregationService() { return this.#aggregation; }

  // Client extension factory
  static asClientExtension(config?: Partial<PDWConfig>) {
    return {
      name: 'pdw' as const,
      register: (client: any) => {
        // Adapt the client to match our expected interface
        const adaptedClient: ClientWithCoreApi = {
          core: {
            getObject: (objectId: string) => client.getObject({ id: objectId }),
            getObjects: (objectIds: string[]) => client.getObjects(objectIds.map(id => ({ id }))),
            executeTransaction: (tx: any) => client.executeTransactionBlock({ transactionBlock: tx }),
          },
          $extend: client.$extend.bind(client),
        };
        return new PersonalDataWallet(adaptedClient, config);
      },
    };
  }
}

// Export for easier usage
export default PersonalDataWallet;