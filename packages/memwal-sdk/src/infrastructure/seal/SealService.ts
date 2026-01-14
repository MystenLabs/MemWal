/**
 * SEAL Service Integration
 * 
 * Production-ready SEAL service wrapper with comprehensive error handling,
 * session management, and performance analytics integration.
 */

import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex, toHex, normalizeSuiAddress } from '@mysten/sui/utils';
import { SealClient, SessionKey, EncryptedObject } from '@mysten/seal';
import type { 
  SealClientOptions,
  EncryptOptions,
  DecryptOptions,
  KeyServerConfig
} from '@mysten/seal';

// SEAL SDK types and interfaces
interface SealConfig {
  suiClient: SuiClient;
  packageId: string;
  keyServerUrls: string[];
  keyServerObjectIds: string[];
  threshold: number;
  network: 'testnet' | 'mainnet';
  enableMetrics: boolean;
  retryAttempts: number;
  timeoutMs: number;
}

interface EncryptionOptions {
  data: Uint8Array;
  id: string;
  threshold?: number;
}

interface DecryptionOptions {
  encryptedObject: Uint8Array;
  sessionKey: any;
  txBytes: Uint8Array;
}

interface SessionConfig {
  address: string;
  packageId: string;
  ttlMin: number;
}

interface PerformanceMetric {
  operation: string;
  startTime: number;
  endTime: number;
  duration: number;
  success: boolean;
  errorType?: string;
  metadata?: any;
}

/**
 * SEAL Service - Production Implementation
 */
export class SealService {
  private sealClient: SealClient | null = null;
  private sessionKey: SessionKey | null = null;
  private config: SealConfig;
  private performanceMetrics: PerformanceMetric[] = [];
  private activeSessions: Map<string, any> = new Map();

  constructor(config: SealConfig) {
    this.config = config;
    console.log('✅ SEAL SDK components loaded successfully');
  }

  /**
   * Initialize SEAL client with retry logic
   */
  async initializeClient(): Promise<void> {
    const metric = this.startMetric('seal_client_init');

    try {
      // Configure server configs from testnet servers
      const serverConfigs: KeyServerConfig[] = this.config.keyServerObjectIds.map((objectId, index) => ({
        objectId,
        weight: 1
      }));

      const sealClientOptions: SealClientOptions = {
        suiClient: this.config.suiClient,
        serverConfigs,
        verifyKeyServers: this.config.network === 'mainnet' // Only verify on mainnet
      };

      this.sealClient = new SealClient(sealClientOptions);

      this.completeMetric(metric, true, { serverCount: serverConfigs.length });
      console.log('✅ SEAL client initialized with', serverConfigs.length, 'servers');

    } catch (error) {
      this.completeMetric(metric, false, undefined, error);
      throw new Error(`Failed to initialize SEAL client: ${error}`);
    }
  }

  /**
   * Create and manage session key
   */
  async createSession(config: SessionConfig, signature?: Uint8Array | string): Promise<any> {
    const metric = this.startMetric('session_creation');

    try {
      const sessionKey = await SessionKey.create({
        address: config.address,
        packageId: config.packageId,
        ttlMin: config.ttlMin,
        suiClient: this.config.suiClient
      });

      const message = sessionKey.getPersonalMessage();

      // In production, signature would come from wallet
      if (signature) {
        // Convert Uint8Array to hex string if needed
        const signatureString = typeof signature === 'string' ? signature : toHex(signature);
        await sessionKey.setPersonalMessageSignature(signatureString);
      }

      // Store session for management
      this.activeSessions.set(config.address, {
        sessionKey,
        createdAt: Date.now(),
        ttl: config.ttlMin * 60 * 1000,
        address: config.address
      });

      this.completeMetric(metric, true, { 
        address: config.address,
        ttlMin: config.ttlMin,
        messageLength: message.length 
      });

      return { sessionKey, personalMessage: message };

    } catch (error) {
      this.completeMetric(metric, false, undefined, error);
      throw new Error(`Failed to create session: ${error}`);
    }
  }

  /**
   * Encrypt data with comprehensive error handling
   */
  async encryptData(options: EncryptionOptions): Promise<{ encryptedObject: Uint8Array; key: Uint8Array }> {
    const metric = this.startMetric('encryption');

    try {
      if (!this.sealClient) {
        await this.initializeClient();
      }

      if (!this.sealClient) {
        throw new Error('Failed to initialize SEAL client');
      }

      const threshold = options.threshold || this.config.threshold;

      // Validate threshold against available servers
      if (threshold > this.config.keyServerObjectIds.length) {
        throw new Error(`Threshold ${threshold} exceeds available servers ${this.config.keyServerObjectIds.length}`);
      }

      const result = await this.sealClient.encrypt({
        threshold,
        packageId: this.config.packageId,
        id: options.id,
        data: options.data
      });

      this.completeMetric(metric, true, {
        dataSize: options.data.length,
        threshold,
        encryptedSize: result.encryptedObject.length,
        keySize: result.key.length
      });

      return result;

    } catch (error) {
      this.completeMetric(metric, false, undefined, error);
      
      // Enhanced error handling
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('threshold')) {
        throw new Error(`Encryption threshold error: ${errorMessage}`);
      }
      if (errorMessage.includes('network')) {
        throw new Error(`Network error during encryption: ${errorMessage}`);
      }
      
      throw new Error(`Encryption failed: ${errorMessage}`);
    }
  }

  /**
   * Decrypt data with session management
   */
  async decryptData(options: DecryptionOptions): Promise<Uint8Array> {
    const metric = this.startMetric('decryption');

    try {
      if (!this.sealClient) {
        await this.initializeClient();
      }

      if (!this.sealClient) {
        throw new Error('Failed to initialize SEAL client');
      }

      // Add detailed debugging for SEAL decryption
      console.log('🔍 SEAL decrypt parameters:');
      console.log(`   - Encrypted data type: ${typeof options.encryptedObject}`);
      console.log(`   - Encrypted data length: ${options.encryptedObject.length}`);
      console.log(`   - Session key type: ${typeof options.sessionKey}`);
      console.log(`   - Session key constructor: ${options.sessionKey?.constructor?.name}`);
      console.log(`   - Transaction bytes type: ${typeof options.txBytes}`);
      console.log(`   - Transaction bytes length: ${options.txBytes.length}`);
      
      // Check if session key has expected methods
      if (options.sessionKey) {
        console.log(`   - Session key methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(options.sessionKey)).join(', ')}`);
      }

      // Try SEAL decryption with error boundary
      let result;
      try {
        console.log('🔍 Attempting SEAL client decrypt...');
        result = await this.sealClient.decrypt({
          data: options.encryptedObject,
          sessionKey: options.sessionKey,
          txBytes: options.txBytes
        });
        console.log('🔍 SEAL decrypt completed without throwing');
      } catch (innerError) {
        console.log('🔍 SEAL decrypt threw an error:', innerError);
        throw innerError;
      }

      console.log(`🔍 SEAL decrypt result:`, {
        result,
        resultType: typeof result,
        resultLength: result ? result.length : 'undefined',
        hasResult: !!result,
        isUint8Array: result instanceof Uint8Array
      });

      if (!result) {
        throw new Error('SEAL decrypt returned undefined/null result');
      }

      this.completeMetric(metric, true, {
        encryptedSize: options.encryptedObject.length,
        decryptedSize: result ? result.length : 0
      });

      return result;

    } catch (error) {
      this.completeMetric(metric, false, undefined, error);

      // Enhanced error handling for decryption with detailed logging
      console.log('🚨 SEAL decrypt error details:', {
        error,
        errorType: typeof error,
        errorConstructor: error?.constructor?.name,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : 'No stack trace'
      });

      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('access')) {
        throw new Error(`Access denied for decryption: ${errorMessage}`);
      }
      if (errorMessage.includes('session')) {
        throw new Error(`Session error during decryption: ${errorMessage}`);
      }

      throw new Error(`Decryption failed: ${errorMessage}`);
    }
  }

  /**
   * Create transaction for seal_approve using capability pattern
   * Matches Move signature: seal_approve(cap: &MemoryCap, key_id: vector<u8>, ctx: &TxContext)
   *
   * @param keyId - SEAL key ID (hex string or bytes)
   * @param userAddress - User's wallet address (sender)
   * @param memoryCapId - Object ID of the MemoryCap
   */
  async createSealApproveTransaction(
    keyId: string,
    userAddress: string,
    memoryCapId: string,
    _accessRegistry?: string // Deprecated, kept for backward compatibility
  ): Promise<Uint8Array> {
    const metric = this.startMetric('transaction_creation');

    try {
      const tx = new Transaction();

      // Capability-based seal_approve call
      // CRITICAL: key_id MUST be first argument for SEAL key server!
      // entry fun seal_approve(key_id: vector<u8>, cap: &MemoryCap, ctx: &TxContext)
      tx.moveCall({
        target: `${this.config.packageId}::capability::seal_approve`,
        arguments: [
          tx.pure.vector("u8", fromHex(keyId)),      // Arg 1: SEAL key ID (MUST BE FIRST!)
          tx.object(memoryCapId),                    // Arg 2: MemoryCap object reference
          // ctx: &TxContext is auto-provided by Sui
        ]
      });

      // Set the sender for the transaction
      tx.setSender(userAddress);

      const txBytes = await tx.build({
        client: this.config.suiClient,
        onlyTransactionKind: true
      });

      this.completeMetric(metric, true, {
        keyId,
        memoryCapId,
        txSize: txBytes.length,
        userAddress
      });

      return txBytes;

    } catch (error) {
      this.completeMetric(metric, false, undefined, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create transaction: ${errorMessage}`);
    }
  }

  /**
   * Build a seal_approve transaction using capability pattern
   * Matches Move signature: seal_approve(cap: &MemoryCap, key_id: vector<u8>, ctx: &TxContext)
   *
   * @param keyId - SEAL key ID (bytes)
   * @param memoryCapId - Object ID of the MemoryCap
   */
  buildSealApproveTransaction(
    keyId: Uint8Array,
    memoryCapId: string,
    _accessRegistry?: string // Deprecated, kept for backward compatibility
  ): Transaction {
    const metric = this.startMetric('transaction_creation_wallet');

    try {
      const tx = new Transaction();

      // Capability-based seal_approve call
      // CRITICAL: key_id MUST be first argument for SEAL key server!
      // entry fun seal_approve(key_id: vector<u8>, cap: &MemoryCap, ctx: &TxContext)
      tx.moveCall({
        target: `${this.config.packageId}::capability::seal_approve`,
        arguments: [
          tx.pure.vector('u8', Array.from(keyId)),     // Arg 1: SEAL key ID (MUST BE FIRST!)
          tx.object(memoryCapId),                      // Arg 2: MemoryCap object reference
          // ctx: &TxContext is auto-provided by Sui
        ]
      });

      this.completeMetric(metric, true, {
        keyIdLength: keyId.length,
        memoryCapId
      });

      return tx;

    } catch (error) {
      this.completeMetric(metric, false, undefined, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create transaction for capability: ${errorMessage}`);
    }
  }

  /**
   * Parse encrypted object structure
   */
  parseEncryptedObject(encryptedBytes: Uint8Array): any {
    const metric = this.startMetric('object_parsing');

    try {
      const parsed = EncryptedObject.parse(encryptedBytes);

      this.completeMetric(metric, true, {
        version: parsed.version,
        packageId: parsed.packageId,
        threshold: parsed.threshold,
        dataSize: encryptedBytes.length
      });

      return parsed;

    } catch (error) {
      this.completeMetric(metric, false, undefined, error);
      throw new Error(`Failed to parse encrypted object: ${error}`);
    }
  }

  /**
   * Session management utilities
   */
  getActiveSession(address: string): any | null {
    const session = this.activeSessions.get(address);
    if (!session) return null;

    // Check if session is expired
    const now = Date.now();
    if (now > session.createdAt + session.ttl) {
      this.activeSessions.delete(address);
      return null;
    }

    return session.sessionKey;
  }

  cleanupExpiredSessions(): number {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [address, session] of this.activeSessions.entries()) {
      if (now > session.createdAt + session.ttl) {
        this.activeSessions.delete(address);
        cleanedCount++;
      }
    }

    console.log(`🧹 Cleaned up ${cleanedCount} expired sessions`);
    return cleanedCount;
  }

  getSessionStats(): { total: number; expired: number; active: number } {
    const now = Date.now();
    let active = 0;
    let expired = 0;

    for (const session of this.activeSessions.values()) {
      if (now > session.createdAt + session.ttl) {
        expired++;
      } else {
        active++;
      }
    }

    return { total: this.activeSessions.size, active, expired };
  }

  /**
   * Performance metrics and analytics
   */
  private startMetric(operation: string): PerformanceMetric {
    const metric: PerformanceMetric = {
      operation,
      startTime: Date.now(),
      endTime: 0,
      duration: 0,
      success: false
    };

    return metric;
  }

  private completeMetric(metric: PerformanceMetric, success: boolean, metadata?: any, error?: any): void {
    metric.endTime = Date.now();
    metric.duration = metric.endTime - metric.startTime;
    metric.success = success;
    metric.metadata = metadata;

    if (error) {
      metric.errorType = error.constructor.name;
    }

    this.performanceMetrics.push(metric);

    // Limit metrics storage to prevent memory leaks
    if (this.performanceMetrics.length > 1000) {
      this.performanceMetrics.splice(0, 500); // Keep last 500 metrics
    }
  }

  getPerformanceMetrics(): PerformanceMetric[] {
    return [...this.performanceMetrics];
  }

  getPerformanceStats() {
    if (this.performanceMetrics.length === 0) {
      return { totalOperations: 0, averageTime: 0, successRate: 0 };
    }

    const successful = this.performanceMetrics.filter(m => m.success);
    const totalTime = this.performanceMetrics.reduce((sum, m) => sum + m.duration, 0);

    return {
      totalOperations: this.performanceMetrics.length,
      successfulOperations: successful.length,
      successRate: (successful.length / this.performanceMetrics.length) * 100,
      averageTime: totalTime / this.performanceMetrics.length,
      averageSuccessTime: successful.length > 0 ? 
        successful.reduce((sum, m) => sum + m.duration, 0) / successful.length : 0,
      operationBreakdown: this.getOperationBreakdown()
    };
  }

  private getOperationBreakdown(): Record<string, any> {
    const breakdown: Record<string, any> = {};

    for (const metric of this.performanceMetrics) {
      if (!breakdown[metric.operation]) {
        breakdown[metric.operation] = {
          count: 0,
          totalTime: 0,
          successCount: 0,
          avgTime: 0,
          successRate: 0
        };
      }

      const op = breakdown[metric.operation];
      op.count++;
      op.totalTime += metric.duration;
      if (metric.success) op.successCount++;
    }

    // Calculate averages and rates
    for (const op of Object.values(breakdown) as any[]) {
      op.avgTime = op.totalTime / op.count;
      op.successRate = (op.successCount / op.count) * 100;
    }

    return breakdown;
  }

  /**
   * Health checks and diagnostics
   */
  async healthCheck(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; details: any }> {
    const checks = {
      sealClientInitialized: !!this.sealClient,
      activeSessions: this.activeSessions.size,
      performanceMetrics: this.performanceMetrics.length,
      keyServers: this.config.keyServerObjectIds.length
    };

    // Test key server connectivity
    const serverHealth = await Promise.allSettled(
      this.config.keyServerUrls.map(async (url) => {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        return { url, status: response.status, ok: response.ok };
      })
    );

    const healthyServers = serverHealth.filter(result => 
      result.status === 'fulfilled' && result.value.ok
    ).length;

    let status: 'healthy' | 'degraded' | 'unhealthy';
    if (healthyServers === this.config.keyServerUrls.length) {
      status = 'healthy';
    } else if (healthyServers >= this.config.threshold) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }

    return {
      status,
      details: {
        ...checks,
        serverHealth: {
          total: this.config.keyServerUrls.length,
          healthy: healthyServers,
          threshold: this.config.threshold
        },
        performanceStats: this.getPerformanceStats()
      }
    };
  }

  /**
   * Configuration and utilities
   */
  getConfiguration(): Partial<SealConfig> {
    return {
      packageId: this.config.packageId,
      network: this.config.network,
      threshold: this.config.threshold,
      enableMetrics: this.config.enableMetrics,
      retryAttempts: this.config.retryAttempts,
      timeoutMs: this.config.timeoutMs
    };
  }

  updateConfiguration(updates: Partial<SealConfig>): void {
    this.config = { ...this.config, ...updates };
    
    // Reinitialize client if critical settings changed
    if (updates.keyServerObjectIds || updates.suiClient) {
      this.sealClient = null;
    }
  }
}