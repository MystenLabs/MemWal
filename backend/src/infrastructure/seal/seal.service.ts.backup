import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SealClient, EncryptedObject, SessionKey } from '@mysten/seal';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { SessionKeyService } from './session-key.service';

/**
 * Simplified SEAL service following the official examples
 * Based on @mysten/seal API patterns from the MystenLabs/seal repository
 */
@Injectable()
export class SealService {
<<<<<<< HEAD
  private readonly sealClient: SealClient;
  private readonly suiClient: SuiClient;
  private readonly logger = new Logger(SealService.name);
  private readonly packageId: string;
  private readonly threshold: number = 2;
=======
  protected sealClient: SealClient;
  protected suiClient: SuiClient;
  protected logger = new Logger(SealService.name);
  public packageId: string;
  protected sealCorePackageId: string = '0x62c79dfeb0a2ca8c308a56bde530ccf3846535e1623949d45c90d23128afff52'; // Official SEAL package
  public moduleName: string;
  public threshold: number;
  public network: 'mainnet' | 'testnet' | 'devnet';
  protected sessionKeys: Map<string, SessionKey> = new Map();
  protected isOpenMode: boolean;
>>>>>>> 175a8dbc02e99cdf82f694d8be93c895b23ba1e0

  constructor(
    private readonly configService: ConfigService,
    private readonly sessionKeyService: SessionKeyService
  ) {
<<<<<<< HEAD
    // Initialize configuration
    const network = this.configService.get<'mainnet' | 'testnet' | 'devnet'>('SEAL_NETWORK', 'testnet');
    this.packageId = this.configService.get<string>('SEAL_PACKAGE_ID', '0xa2b73c54b9f354050462547787463e79f33b48fc6c1fea35673f12e3a535ec60');

    // Initialize Sui client
    this.suiClient = new SuiClient({
      url: this.configService.get<string>('SUI_RPC_URL', getFullnodeUrl(network))
    });

    // Initialize SEAL client with configured key servers
    const keyServerIds = this.configService.get<string[]>('SEAL_KEY_SERVER_IDS', [
      // Default testnet key servers from the official example
      '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
      '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8'
    ]);
    const serverConfigs = keyServerIds.map(id => ({ objectId: id, weight: 1 }));
=======
    // Initialize configuration - Use our published package by default
    this.network = this.configService.get<'mainnet' | 'testnet' | 'devnet'>('SEAL_NETWORK', 'testnet');
    this.packageId = this.configService.get<string>('SEAL_PACKAGE_ID', '0x04f20b1582388004e954117041135391b1d52e0bb39a9af4aa92157735b7c6a3');
    this.moduleName = this.configService.get<string>('SEAL_MODULE_NAME', 'seal_access_control');
    this.threshold = this.configService.get<number>('SEAL_THRESHOLD', 2);
    this.isOpenMode = false; // Disable open mode - use standard SEAL Client only

    // Initialize Sui client following SDK examples
    this.suiClient = new SuiClient({ 
      url: this.configService.get<string>('SUI_RPC_URL', getFullnodeUrl(this.network))
    });

    // Initialize SEAL client with proper configuration based on SDK documentation
    // Use the same key servers as in the example app
    const keyServerIds = this.configService.get<string[]>('SEAL_KEY_SERVER_IDS', []);
    const serverConfigs = keyServerIds.length > 0 
      ? keyServerIds.map(id => ({ objectId: id, weight: 1 }))
      : [
          { objectId: "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75", weight: 1 },
          { objectId: "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8", weight: 1 }
        ];
>>>>>>> 175a8dbc02e99cdf82f694d8be93c895b23ba1e0

    // Initialize SealClient following example app patterns
    this.sealClient = new SealClient({
      suiClient: this.suiClient as any, // Type assertion to bypass compatibility issue
      serverConfigs,
<<<<<<< HEAD
      verifyKeyServers: false,
    });

    this.logger.log(`SEAL service initialized with ${serverConfigs.length} key servers on ${network}`);
    this.logger.log(`Package ID: ${this.packageId || 'Not configured'}`);
=======
      verifyKeyServers: true, // Always verify key servers in standard mode
    });

    this.logger.log(`SEAL service initialized with ${serverConfigs.length} key servers on ${this.network}`);
    this.logger.log(`Operating in STANDARD mode (open mode disabled)`);
    this.logger.log(`Using published package ID: ${this.packageId}`);
    this.logger.log(`Using module name: ${this.moduleName}`);
>>>>>>> 175a8dbc02e99cdf82f694d8be93c895b23ba1e0
  }

  /**
   * Encrypt data using SEAL with access control
   * Following the pattern from official examples
   */
  async encrypt(
<<<<<<< HEAD
    data: Uint8Array,
    policyObjectId: string,
    nonce: string = Math.random().toString(36)
  ): Promise<{ encrypted: Uint8Array; identityId: string }> {
    try {
      // Create identity by combining policy object ID with nonce
      // This follows the pattern from the official examples
      const identityId = `${policyObjectId}:${nonce}`;

      const result = await this.sealClient.encrypt({
=======
    content: string, 
    userAddress: string
  ): Promise<{ encrypted: string; backupKey: string }> {
    try {
      // Convert content to bytes
      const data = new TextEncoder().encode(content);
      
      // Use configured package ID (no custom packages in standard mode)
      const packageIdToUse = this.packageId;
      
      // Standard SEAL identity format following SDK patterns
      const identityString = `self:${userAddress}`;
      const identityBytes = new TextEncoder().encode(identityString);
      const id = toHEX(identityBytes);
      
      this.logger.debug(`Encrypting with identity: ${identityString}`);
      this.logger.debug(`Package: ${packageIdToUse}, Threshold: ${this.threshold}`);
      
      // Encrypt using SEAL Client following SDK documentation
      const { encryptedObject, key: backupKey } = await this.sealClient.encrypt({
>>>>>>> 175a8dbc02e99cdf82f694d8be93c895b23ba1e0
        threshold: this.threshold,
        packageId: this.packageId,
        id: identityId,
        data,
      });

<<<<<<< HEAD
=======
      // Convert encrypted bytes to base64 for storage
      const encrypted = Buffer.from(encryptedObject).toString('base64');
      const backupKeyHex = toHEX(backupKey);

      this.logger.debug(`Successfully encrypted content for user ${userAddress}`);
      this.logger.debug(`Encrypted size: ${encryptedObject.length} bytes`);
      
>>>>>>> 175a8dbc02e99cdf82f694d8be93c895b23ba1e0
      return {
        encrypted: result.encryptedObject,
        identityId,
      };
    } catch (error) {
<<<<<<< HEAD
      this.logger.error('Failed to encrypt data', error);
      throw new Error(`Encryption failed: ${error.message}`);
=======
      this.logger.error(`SEAL encryption failed: ${error.message}`);
      
      // Handle specific SEAL errors based on SDK documentation
      if (error.name === 'SealAPIError') {
        throw new Error(`Key server error during encryption: ${error.message}`);
      } else if (error.name === 'InvalidKeyServerError') {
        throw new Error(`Invalid key server configuration: ${error.message}`);
      } else if (error.name === 'DeprecatedSDKVersionError') {
        throw new Error(`SEAL SDK version is deprecated, please update: ${error.message}`);
      } else {
        throw new Error(`SEAL encryption error: ${error.message}`);
      }
>>>>>>> 175a8dbc02e99cdf82f694d8be93c895b23ba1e0
    }
  }

  /**
   * Decrypt data using SEAL with SessionKey and transaction validation
   * Following the pattern from official examples
   */
  async decrypt(
<<<<<<< HEAD
    encryptedData: Uint8Array,
    moveCallConstructor: (tx: Transaction, id: string) => void,
    userAddress: string
  ): Promise<Uint8Array> {
    try {
      // Parse the encrypted object to get the identity ID
      const encryptedObject = EncryptedObject.parse(encryptedData);
      const identityId = encryptedObject.id;

      this.logger.debug(`Decrypting data with identity: ${identityId} for user: ${userAddress}`);

      // Get or create session key for the user
      let sessionKey = await this.sessionKeyService.getSessionKey(userAddress, this.packageId);

      if (!sessionKey) {
        throw new Error('No valid session key found. Please create a session first.');
      }

      // Build transaction with the appropriate seal_approve call
      const tx = new Transaction();
      moveCallConstructor(tx, identityId);
      const txBytes = await tx.build({ client: this.suiClient, onlyTransactionKind: true });

      // First, fetch keys from key servers
      await this.sealClient.fetchKeys({
        ids: [identityId],
=======
    encryptedContent: string, 
    userAddress: string,
    signature?: string
  ): Promise<string> {
    try {
      // Use configured package and module (no custom packages in standard mode)
      const packageIdToUse = this.packageId;
      const moduleNameToUse = this.moduleName;
      
      // Get or create session key following SDK patterns
      const sessionKey = await this.getOrCreateSessionKey(userAddress, signature, packageIdToUse);
      
      // Convert encrypted content from base64 to bytes
      const encryptedBytes = new Uint8Array(Buffer.from(encryptedContent, 'base64'));
      
      // Standard SEAL identity format following SDK patterns
      const identityString = `self:${userAddress}`;
      const identityBytes = new TextEncoder().encode(identityString);
      const id = toHEX(identityBytes);
      
      this.logger.debug(`Decrypting with identity: ${identityString}`);
      this.logger.debug(`Package: ${packageIdToUse}, Module: ${moduleNameToUse}`);
      
      // Build transaction with seal_approve_self call (updated function name)
      const tx = new Transaction();
      tx.moveCall({
        target: `${packageIdToUse}::${moduleNameToUse}::seal_approve_self`,
        arguments: [
          tx.pure.vector("u8", fromHEX(id)),
        ]
      });
      
      const txBytes = await tx.build({ 
        client: this.suiClient, 
        onlyTransactionKind: true 
      });
      
      this.logger.debug(`Built transaction for SEAL approval`);
      
      // Decrypt using SEAL Client following SDK documentation
      const decryptedBytes = await this.sealClient.decrypt({
        data: encryptedBytes,
        sessionKey,
        txBytes,
      });

      // Convert decrypted bytes to string
      const decrypted = new TextDecoder().decode(decryptedBytes);
      
      this.logger.debug(`Successfully decrypted content for user ${userAddress}`);
      
      return decrypted;
    } catch (error) {
      this.logger.error(`SEAL decryption failed: ${error.message}`);
      
      // Handle specific SEAL errors based on SDK documentation
      if (error.name === 'DecryptionError') {
        throw new Error(`Decryption failed - content may be corrupted or access denied: ${error.message}`);
      } else if (error.name === 'ExpiredSessionKeyError') {
        throw new Error(`Session key expired - please re-authenticate: ${error.message}`);
      } else if (error.name === 'SealAPIError') {
        throw new Error(`Key server error during decryption: ${error.message}`);
      } else if (error.name === 'InconsistentKeyServersError') {
        throw new Error(`Key servers returned inconsistent data - please try again: ${error.message}`);
      } else {
        throw new Error(`SEAL decryption error: ${error.message}`);
      }
    }
  }

  /**
   * Decrypt content using backup symmetric key
   * @param encryptedContent The encrypted content (base64)
   * @param backupKey The backup symmetric key (hex)
   * @returns The decrypted content
   */
  async decryptWithBackupKey(
    encryptedContent: string, 
    backupKey: string
  ): Promise<string> {
    try {
      // This would use SEAL's symmetric decryption
      // For now, throw not implemented
      throw new Error('Backup key decryption not yet implemented');
    } catch (error) {
      this.logger.error(`Error decrypting with backup key: ${error.message}`);
      throw new Error(`Backup key decryption error: ${error.message}`);
    }
  }

  /**
   * Create or get a session key for a user
   * @param userAddress The user address
   * @param signature Optional signature from user
   * @param packageId Package ID for the session
   * @returns The session key
   */
  protected async getOrCreateSessionKey(
    userAddress: string, 
    signature?: string,
    packageId?: string
  ): Promise<SessionKey> {
    // Use provided package ID or fall back to our published package
    const pkgId = packageId || this.packageId;
    const cacheKey = `${userAddress}:${pkgId}`;
    
    // Check if we have a cached session key
    const cached = this.sessionKeys.get(cacheKey);
    const sessionData = this.sessionStore.get(cacheKey);
    
    // Check for expired session keys following SDK patterns
    if (cached && cached.isExpired()) {
      this.logger.debug(`Session key expired for ${userAddress}, removing from cache`);
      this.sessionKeys.delete(cacheKey);
      this.sessionStore.delete(cacheKey);
    } else if (cached && sessionData && sessionData.signature) {
      this.logger.debug(`Using cached SessionKey for ${userAddress}`);
      return cached;
    }

    // If we have a cached SessionKey but need to set a new signature
    if (cached && signature && (!sessionData || !sessionData.signature)) {
      this.logger.debug(`Setting signature on existing SessionKey for ${userAddress}`);
      try {
        await cached.setPersonalMessageSignature(signature);
        this.logger.debug(`Signature set successfully on cached SessionKey`);
        
        // Update session data with signature
        if (sessionData) {
          sessionData.signature = signature;
          this.sessionStore.set(cacheKey, sessionData);
        }
        return cached;
      } catch (error) {
        this.logger.error(`Failed to set signature on cached SessionKey: ${error.message}`);
        // Continue to create new SessionKey
      }
    }

    // If we have session data, use the cached SessionKey from getSessionKeyMessage
    if (sessionData && cached) {
      if (signature) {
        this.logger.debug(`Setting new signature on cached SessionKey for ${userAddress}`);
        try {
          await cached.setPersonalMessageSignature(signature);
          this.logger.debug(`Signature set successfully`);
          
          // Update session data with signature
          sessionData.signature = signature;
          this.sessionStore.set(cacheKey, sessionData);
        } catch (error) {
          this.logger.error(`Failed to set signature: ${error.message}`);
          throw new Error(`Failed to set session key signature: ${error.message}`);
        }
      } else if (sessionData.signature) {
        // Try to set stored signature
        try {
          await cached.setPersonalMessageSignature(sessionData.signature);
          this.logger.debug(`Set stored signature on cached SessionKey`);
        } catch (error) {
          this.logger.warn(`Failed to set stored signature: ${error.message}`);
          throw new Error('User signature required for session key initialization');
        }
      } else {
        throw new Error('User signature required for session key initialization');
      }
      return cached;
    }

    // No session data exists, this shouldn't happen if getSessionKeyMessage was called first
    throw new Error('No session found. Please request session message first.');
  }

  /**
   * Get the personal message that needs to be signed for session key
   * @param userAddress The user address
   * @param packageId Optional package ID (for open mode)
   * @returns The message to be signed
   */
  async getSessionKeyMessage(userAddress: string): Promise<Uint8Array> {
    // Use our published package ID
    const pkgId = this.packageId;
    const cacheKey = `${userAddress}:${pkgId}`;
    
    // Check if we already have a session for this address
    const existingSession = this.sessionStore.get(cacheKey);
    if (existingSession && !existingSession.signature) {
      // Return the existing personal message if no signature set yet
      return Buffer.from(existingSession.personalMessage, 'hex');
    }

    const ttlMin = this.configService.get<number>('SEAL_SESSION_TTL_MIN', 10); // Default to 10 minutes like example

    // Create SessionKey following SDK documentation patterns
    const sessionKey = new SessionKey({
      address: userAddress,
      packageId: pkgId,
      ttlMin,
      suiClient: this.suiClient,
    });

    const personalMessage = sessionKey.getPersonalMessage();
    
    this.logger.debug(`Created session key for ${userAddress} with TTL ${ttlMin} minutes`);
    this.logger.debug(`Package ID: ${pkgId}`);
    
    // Store the session data
    this.sessionStore.set(cacheKey, {
      address: userAddress,
      personalMessage: Buffer.from(personalMessage).toString('hex'),
      expiresAt: Date.now() + (ttlMin * 60 * 1000),
    });

    // Also cache the SessionKey instance
    this.sessionKeys.set(cacheKey, sessionKey);

    return personalMessage;
  }

  /**
   * Check if a session key is expired
   * @param sessionKey The session key to check
   * @returns True if expired
   */
  protected isSessionKeyExpired(sessionKey: SessionKey): boolean {
    // SessionKey doesn't expose expiry directly, so we'll manage it externally
    // In a real implementation, you'd track creation time and TTL
    return false;
  }

  /**
   * Get current mode
   * @returns Whether service is in open mode
   */
  isInOpenMode(): boolean {
    return this.isOpenMode;
  }

  /**
   * Fetch multiple keys in batch (for efficiency)
   * @param ids Array of identity IDs
   * @param userAddress The user address
   * @param signature Optional signature for session key
   * @param packageId Optional package ID (for open mode)
   * @param moduleName Optional module name (for open mode)
   * @returns Map of id to decryption result
   */
  async fetchMultipleKeys(
    ids: string[],
    userAddress: string,
    signature?: string
  ): Promise<Map<string, Uint8Array>> {
    try {
      // Use configured package and module (no custom packages in standard mode)
      const pkgId = this.packageId;
      const modName = this.moduleName;
      
      // Get session key
      const sessionKey = await this.getOrCreateSessionKey(userAddress, signature, pkgId);
      
      // Build transaction with multiple seal_approve calls
      const tx = new Transaction();
      for (const id of ids) {
        tx.moveCall({
          target: `${pkgId}::${modName}::seal_approve`,
          arguments: [
            tx.pure.vector("u8", fromHEX(id)),
          ],
        });
      }

      const txBytes = await tx.build({ 
        client: this.suiClient, 
        onlyTransactionKind: true 
      });

      // Fetch keys from SEAL
      const keys = await this.sealClient.fetchKeys({
        ids: ids,
>>>>>>> 175a8dbc02e99cdf82f694d8be93c895b23ba1e0
        txBytes,
        sessionKey,
        threshold: this.threshold,
      });

      // Then decrypt the data locally
      const decrypted = await this.sealClient.decrypt({
        data: encryptedData,
        sessionKey,
        txBytes,
      });

      this.logger.debug(`Successfully decrypted data for user: ${userAddress}`);
      return decrypted;

    } catch (error) {
      this.logger.error('Failed to decrypt data', error);
      throw new Error(`Decryption failed: ${error.message}`);
    }
  }

  /**
<<<<<<< HEAD
   * Create a transaction builder for self access
   */
  createSelfAccessTransaction(userAddress: string) {
    return (tx: Transaction, id: string) => {
      tx.moveCall({
        target: `${this.packageId}::seal_access_control::seal_approve`,
        arguments: [
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(id))),
        ],
      });
    };
  }

  /**
   * Create a transaction builder for app access
   */
  createAppAccessTransaction(allowlistId: string) {
    return (tx: Transaction, id: string) => {
      tx.moveCall({
        target: `${this.packageId}::seal_access_control::seal_approve_app`,
        arguments: [
          tx.object(allowlistId),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(id))),
        ],
      });
    };
  }

  /**
   * Create a transaction builder for timelock access
   */
  createTimelockAccessTransaction(timelockId: string) {
    return (tx: Transaction, id: string) => {
      tx.moveCall({
        target: `${this.packageId}::seal_access_control::seal_approve_timelock`,
        arguments: [
          tx.object(timelockId),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(id))),
        ],
      });
    };
  }

  /**
   * Encrypt data with time-lock access control
   */
  async encryptWithTimelock(
    data: Uint8Array,
    unlockTimestamp: number,
    nonce: string = Math.random().toString(36),
  ): Promise<{
    encrypted: Uint8Array;
    identityId: string;
    unlockTime: number;
  }> {
    try {
      // Create identity with timestamp for time-lock
      const identityId = `timelock_${unlockTimestamp}_${nonce}`;

      const result = await this.sealClient.encrypt({
        threshold: this.threshold,
        packageId: this.packageId,
        id: identityId,
        data,
      });

      this.logger.debug(
        `Encrypted data with time-lock identity: ${identityId}`,
      );

      return {
        encrypted: result.encryptedObject,
        identityId,
        unlockTime: unlockTimestamp,
      };
    } catch (error) {
      this.logger.error('Failed to encrypt data with time-lock', error);
      throw new Error(`Time-lock encryption failed: ${(error as Error).message}`);
=======
   * Create allowlist for sharing encrypted data with other addresses
   * @param name The name of the allowlist
   * @param userAddress The owner's address
   * @returns The created allowlist ID
   */
  async createAllowlist(name: string, userAddress: string): Promise<string> {
    try {
      // Build transaction to create allowlist
      const tx = new Transaction();
      tx.moveCall({
        target: `${this.packageId}::${this.moduleName}::create_allowlist_entry`,
        arguments: [
          tx.pure.string(name),
        ]
      });

      // This would need to be executed by the frontend with user's wallet
      // For now, we'll return the transaction bytes for frontend execution
      const txBytes = await tx.build({ 
        client: this.suiClient, 
        onlyTransactionKind: true 
      });

      this.logger.debug(`Created allowlist creation transaction for ${userAddress}`);
      
      // In production, return transaction for frontend execution
      throw new Error('Allowlist creation must be executed by user wallet on frontend');
    } catch (error) {
      this.logger.error(`Error creating allowlist: ${error.message}`);
      throw new Error(`Allowlist creation failed: ${error.message}`);
    }
  }

  /**
   * Encrypt data for allowlist access (requires allowlist namespace)
   * @param content The content to encrypt
   * @param allowlistId The allowlist ID for namespace prefixing
   * @param userAddress The user's address
   * @returns The encrypted content and backup key
   */
  async encryptForAllowlist(
    content: string,
    allowlistId: string,
    userAddress: string
  ): Promise<{ encrypted: string; backupKey: string }> {
    try {
      // Convert content to bytes
      const data = new TextEncoder().encode(content);
      
      // Create identity with allowlist namespace prefix (following example pattern)
      const nonce = crypto.getRandomValues(new Uint8Array(5));
      const allowlistBytes = fromHEX(allowlistId.replace('0x', ''));
      const identityBytes = new Uint8Array([...allowlistBytes, ...nonce]);
      const id = toHEX(identityBytes);
      
      this.logger.debug(`Encrypting for allowlist: ${allowlistId}`);
      this.logger.debug(`Identity: ${id}`);
      
      // Encrypt using SEAL Client
      const { encryptedObject, key: backupKey } = await this.sealClient.encrypt({
        threshold: this.threshold,
        packageId: this.packageId,
        id: id,
        data,
      });

      // Convert encrypted bytes to base64 for storage
      const encrypted = Buffer.from(encryptedObject).toString('base64');
      const backupKeyHex = toHEX(backupKey);

      this.logger.debug(`Successfully encrypted content for allowlist ${allowlistId}`);
      
      return {
        encrypted,
        backupKey: backupKeyHex,
      };
    } catch (error) {
      this.logger.error(`Allowlist encryption failed: ${error.message}`);
      throw new Error(`SEAL allowlist encryption error: ${error.message}`);
>>>>>>> 175a8dbc02e99cdf82f694d8be93c895b23ba1e0
    }
  }

  /**
<<<<<<< HEAD
   * Decrypt time-locked data
   */
  async decryptTimelock(
    encryptedData: Uint8Array,
    userAddress: string
  ): Promise<Uint8Array> {
    try {
      // Parse the encrypted object to get the identity ID
      const encryptedObject = EncryptedObject.parse(encryptedData);
      const identityId = encryptedObject.id;

      this.logger.debug(`Decrypting time-locked data with identity: ${identityId} for user: ${userAddress}`);

      // Extract timestamp from identity to validate unlock time
      const timestampMatch = identityId.match(/timelock_(\d+)_/);
      if (!timestampMatch) {
        throw new Error('Invalid time-lock identity format');
      }

      const unlockTimestamp = parseInt(timestampMatch[1]);
      const currentTimestamp = Date.now();

      if (currentTimestamp < unlockTimestamp) {
        throw new Error(`Time-lock not yet expired. Unlocks at: ${new Date(unlockTimestamp).toISOString()}`);
      }

      // Get or create session key for the user
      let sessionKey = await this.sessionKeyService.getSessionKey(userAddress, this.packageId);

      if (!sessionKey) {
        throw new Error('No valid session key found. Please create a session first.');
      }

      // Build transaction with time-lock seal_approve call
      const tx = new Transaction();
      // For timelock, we use the SUI clock object
      const moveCallConstructor = this.createTimelockAccessTransaction('0x6'); // SUI_CLOCK_OBJECT_ID
      moveCallConstructor(tx, identityId);
      const txBytes = await tx.build({ client: this.suiClient, onlyTransactionKind: true });

      // First, fetch keys from key servers
      await this.sealClient.fetchKeys({
        ids: [identityId],
        txBytes,
        sessionKey,
        threshold: this.threshold,
      });

      // Then decrypt the data locally
      const decrypted = await this.sealClient.decrypt({
        data: encryptedData,
=======
   * Decrypt allowlist-encrypted content
   * @param encryptedContent The encrypted content (base64)
   * @param allowlistId The allowlist ID used for encryption
   * @param userAddress The user's address (must be in allowlist)
   * @param signature The user's signature for session key
   * @returns The decrypted content
   */
  async decryptFromAllowlist(
    encryptedContent: string,
    allowlistId: string,
    userAddress: string,
    signature?: string
  ): Promise<string> {
    try {
      // Get session key
      const sessionKey = await this.getOrCreateSessionKey(userAddress, signature, this.packageId);
      
      // Convert encrypted content from base64 to bytes
      const encryptedBytes = new Uint8Array(Buffer.from(encryptedContent, 'base64'));
      
      // Create identity with allowlist namespace prefix
      const nonce = crypto.getRandomValues(new Uint8Array(5));
      const allowlistBytes = fromHEX(allowlistId.replace('0x', ''));
      const identityBytes = new Uint8Array([...allowlistBytes, ...nonce]);
      const id = toHEX(identityBytes);
      
      // Build transaction with seal_approve call for allowlist
      const tx = new Transaction();
      tx.moveCall({
        target: `${this.packageId}::${this.moduleName}::seal_approve`,
        arguments: [
          tx.pure.vector("u8", fromHEX(id)),
          tx.object(allowlistId), // Pass allowlist object for access check
        ]
      });
      
      const txBytes = await tx.build({ 
        client: this.suiClient, 
        onlyTransactionKind: true 
      });
      
      this.logger.debug(`Decrypting from allowlist: ${allowlistId}`);
      this.logger.debug(`Identity: ${id}`);
      
      // Decrypt using SEAL Client
      const decryptedBytes = await this.sealClient.decrypt({
        data: encryptedBytes,
>>>>>>> 175a8dbc02e99cdf82f694d8be93c895b23ba1e0
        sessionKey,
        txBytes,
      });

<<<<<<< HEAD
      this.logger.debug(`Successfully decrypted time-locked data for user: ${userAddress}`);
      return decrypted;

    } catch (error) {
      this.logger.error('Failed to decrypt time-locked data', error);
      throw new Error(`Time-lock decryption failed: ${error.message}`);
    }
  }

  /**
   * Create a transaction builder for role access
   */
  createRoleAccessTransaction(roleRegistryId: string, userAddress: string, role: string) {
    return (tx: Transaction, id: string) => {
      tx.moveCall({
        target: `${this.packageId}::seal_access_control::seal_approve_role`,
        arguments: [
          tx.object(roleRegistryId),
          tx.pure.address(userAddress),
          tx.pure.string(role),
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(id))),
        ],
      });
    };
  }

  /**
   * Get the Sui client instance
   */
  getSuiClient(): SuiClient {
    return this.suiClient;
  }

  /**
   * Get the SEAL client instance
   */
  getSealClient(): SealClient {
    return this.sealClient;
  }

  /**
   * Create a transaction builder for allowlist access
   */
  createAllowlistAccessTransaction(userAddress: string, allowedAddresses: string[]) {
    return (tx: Transaction, id: string) => {
      tx.moveCall({
        target: `${this.packageId}::seal_access_control::seal_approve_allowlist`,
        arguments: [
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(id))),
          tx.pure.address(userAddress),
          tx.pure.vector('address', allowedAddresses),
        ],
      });
    };
  }
=======
      // Convert decrypted bytes to string
      const decrypted = new TextDecoder().decode(decryptedBytes);
      
      this.logger.debug(`Successfully decrypted content from allowlist ${allowlistId}`);
      
      return decrypted;
    } catch (error) {
      this.logger.error(`Allowlist decryption failed: ${error.message}`);
      
      // Handle specific SEAL errors
      if (error.name === 'DecryptionError') {
        throw new Error(`Access denied - you may not be in the allowlist or content is corrupted: ${error.message}`);
      } else if (error.name === 'ExpiredSessionKeyError') {
        throw new Error(`Session key expired - please re-authenticate: ${error.message}`);
      } else {
        throw new Error(`SEAL allowlist decryption error: ${error.message}`);
      }
    }
  }
>>>>>>> 175a8dbc02e99cdf82f694d8be93c895b23ba1e0
}