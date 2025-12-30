import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { 
  SuiClient, 
  getFullnodeUrl
} from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { ChatMessage, ChatSession } from '../../types/chat.types';

@Injectable()
export class SuiService {
  private client: SuiClient;
  private packageId: string;
  private adminKeypair: Ed25519Keypair;
  private logger = new Logger(SuiService.name);

  constructor(private configService: ConfigService) {
    // Initialize Sui client
    const network = this.configService.get<string>('SUI_NETWORK', 'testnet');
    
    // Ensure network is a valid Sui network
    let networkUrl: string;
    
    if (network === 'testnet') {
      networkUrl = getFullnodeUrl('testnet');
    } else if (network === 'mainnet') {
      networkUrl = getFullnodeUrl('mainnet');
    } else if (network === 'devnet') {
      networkUrl = getFullnodeUrl('devnet');
    } else if (network === 'localnet') {
      networkUrl = getFullnodeUrl('localnet');
    } else {
      this.logger.warn(`Invalid SUI_NETWORK: ${network}, falling back to testnet`);
      networkUrl = getFullnodeUrl('testnet');
    }
    
    this.client = new SuiClient({ url: networkUrl });
    
    // Get package ID from config
    let packageId = this.configService.get<string>('SUI_PACKAGE_ID');
    
    // Handle potential malformed package ID (split across lines)
    if (packageId && packageId.length < 66 && packageId.startsWith('0x')) {
      this.logger.warn('Malformed SUI_PACKAGE_ID detected, using default instead');
      packageId = undefined;
    }
    
    if (!packageId) {
      this.logger.warn('SUI_PACKAGE_ID not provided or invalid, using default');
      this.packageId = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    } else {
      this.packageId = packageId;
    }
    
    this.logger.log(`Using SUI_PACKAGE_ID: ${this.packageId}`); // Log the package ID being used
    
    // Initialize admin keypair for gas
    let privateKey = this.configService.get<string>('SUI_ADMIN_PRIVATE_KEY');
    
    // Handle potentially malformed private key (split across lines)
    try {
      if (privateKey) {
        // Clean up the private key and ensure it's in the right format
        privateKey = privateKey.replace(/\s+/g, ''); // Remove any whitespace
        
        if (!privateKey.startsWith('0x')) {
          privateKey = '0x' + privateKey;
        }
        
        // Ensure it's the right length after removing 0x prefix
        const keyBuffer = Buffer.from(privateKey.replace('0x', ''), 'hex');
        if (keyBuffer.length !== 32) {
          throw new Error(`Invalid key length: ${keyBuffer.length}, expected 32`);
        }
        
        this.adminKeypair = Ed25519Keypair.fromSecretKey(keyBuffer);
        const adminAddress = this.adminKeypair.getPublicKey().toSuiAddress();
    this.logger.log(`SUI admin keypair initialized successfully with address: ${adminAddress}`);
      } else {
        this.logger.warn('SUI_ADMIN_PRIVATE_KEY not provided, some operations may fail');
      }
    } catch (error) {
      this.logger.error(`Failed to initialize admin keypair: ${error.message}`);
      this.logger.warn('Using mock keypair for development');
      
      // Generate a random keypair for development/testing
      this.adminKeypair = new Ed25519Keypair();
    }
  }

  // CHAT SESSIONS METHODS

  /**
   * Get all chat sessions for a user
   */
  async getChatSessions(userAddress: string): Promise<ChatSession[]> {
    try {
      // Query all ChatSession objects owned by the user
      const response = await this.client.getOwnedObjects({
        owner: userAddress,
        filter: {
          StructType: `${this.packageId}::chat_sessions::ChatSession`
        },
        options: {
          showContent: true,
        },
      });

      const sessions: ChatSession[] = [];

      for (const item of response.data) {
        if (!item.data?.content) continue;

        const content = item.data.content as any;
        const fields = content.fields;
        
        // Process session data
        sessions.push({
          id: item.data.objectId,
          owner: fields.owner,
          title: fields.model_name, // Use model name as title initially
          messages: this.deserializeMessages(fields.messages),
          created_at: new Date().toISOString(), // Use creation time if available
          updated_at: new Date().toISOString(), // Use update time if available
          message_count: fields.messages.length,
          sui_object_id: item.data.objectId
        });
      }

      return sessions;
    } catch (error) {
      this.logger.error(`Error getting chat sessions: ${error.message}`);
      throw new Error(`Failed to get chat sessions: ${error.message}`);
    }
  }

  /**
   * Create a new chat session
   */
  async createChatSession(userAddress: string, modelName: string): Promise<string> {
    try {
      const tx = new Transaction();
      
      tx.moveCall({
        target: `${this.packageId}::chat_sessions::create_session`,
        arguments: [
          tx.pure(modelName),
        ],
      });

      const result = await this.executeTransaction(tx, userAddress);
      const objectId = this.extractCreatedObjectId(result);
      
      return objectId;
    } catch (error) {
      this.logger.error(`Error creating chat session: ${error.message}`);
      throw new Error(`Failed to create chat session: ${error.message}`);
    }
  }

  /**
   * Add a message to a session
   */
  async addMessageToSession(
    sessionId: string, 
    userAddress: string,
    role: string, 
    content: string
  ): Promise<boolean> {
    try {
      const tx = new Transaction();
      
      // Get the chat session object
      tx.moveCall({
        target: `${this.packageId}::chat_sessions::add_message_to_session`,
        arguments: [
          tx.object(sessionId),
          tx.pure(role),
          tx.pure(content),
        ],
      });

      await this.executeTransaction(tx, userAddress);
      return true;
    } catch (error) {
      this.logger.error(`Error adding message to session: ${error.message}`);
      throw new Error(`Failed to add message to session: ${error.message}`);
    }
  }

  /**
   * Save session summary
   */
  async saveSessionSummary(
    sessionId: string, 
    userAddress: string,
    summary: string
  ): Promise<boolean> {
    try {
      const tx = new Transaction();
      
      tx.moveCall({
        target: `${this.packageId}::chat_sessions::save_session_summary`,
        arguments: [
          tx.object(sessionId),
          tx.pure(summary),
        ],
      });

      await this.executeTransaction(tx, userAddress);
      return true;
    } catch (error) {
      this.logger.error(`Error saving session summary: ${error.message}`);
      throw new Error(`Failed to save session summary: ${error.message}`);
    }
  }

  /**
   * Get a specific chat session
   */
  async getChatSession(sessionId: string): Promise<{
    owner: string;
    modelName: string;
    messages: ChatMessage[];
    summary: string;
  }> {
    try {
      const object = await this.client.getObject({
        id: sessionId,
        options: {
          showContent: true,
        },
      });

      if (!object || !object.data || !object.data.content) {
        throw new Error(`Chat session ${sessionId} not found`);
      }

      const content = object.data.content as any;
      return {
        owner: content.fields.owner,
        modelName: content.fields.model_name,
        messages: this.deserializeMessages(content.fields.messages),
        summary: content.fields.summary,
      };
    } catch (error) {
      this.logger.error(`Error getting chat session: ${error.message}`);
      throw new Error(`Failed to get chat session: ${error.message}`);
    }
  }

  /**
   * Delete a chat session
   */
  async deleteSession(sessionId: string, userAddress: string): Promise<boolean> {
    try {
      // First verify the user owns the session
      const session = await this.getChatSession(sessionId);
      if (session.owner !== userAddress) {
        throw new Error('You do not own this session');
      }
      
      // Create transaction to delete the session
      const tx = new Transaction();
      
      // In a real implementation, you would call a delete function
      // Here we're transferring ownership to a burn address as an example
      tx.transferObjects(
        [tx.object(sessionId)],
        tx.pure('0x000000000000000000000000000000000000000000000000000000000000dead')
      );
      
      await this.executeTransaction(tx, userAddress);
      return true;
    } catch (error) {
      this.logger.error(`Error deleting session: ${error.message}`);
      throw new Error(`Failed to delete session: ${error.message}`);
    }
  }

  /**
   * Update session title (note: this is a mock since our contract doesn't have this function)
   */
  async updateSessionTitle(
    sessionId: string,
    userAddress: string,
    title: string
  ): Promise<boolean> {
    // In a real implementation, we would update the title in the contract
    // For now, we just verify ownership and pretend we updated it
    try {
      const session = await this.getChatSession(sessionId);
      if (session.owner !== userAddress) {
        throw new Error('You do not own this session');
      }
      
      // We would update the title here if the contract supported it
      return true;
    } catch (error) {
      this.logger.error(`Error updating session title: ${error.message}`);
      throw new Error(`Failed to update session title: ${error.message}`);
    }
  }

  // MEMORY METHODS

  /**
   * Create a memory record
   */
  async createMemoryRecord(
    userAddress: string, 
    category: string, 
    vectorId: number,
    blobId: string
  ): Promise<string> {
    try {
      const tx = new Transaction();
      
      tx.moveCall({
        target: `${this.packageId}::memory::create_memory_record`,
        arguments: [
          tx.pure(category),
          tx.pure(vectorId),
          tx.pure(blobId),
        ],
      });

      const result = await this.executeTransaction(tx, userAddress);
      const objectId = this.extractCreatedObjectId(result);
      
      return objectId;
    } catch (error) {
      this.logger.error(`Error creating memory record: ${error.message}`);
      throw new Error(`Failed to create memory record: ${error.message}`);
    }
  }

  /**
   * Create a memory index
   */
  async createMemoryIndex(
    userAddress: string, 
    indexBlobId: string, 
    graphBlobId: string
  ): Promise<string> {
    try {
      const tx = new Transaction();
      
      tx.moveCall({
        target: `${this.packageId}::memory::create_memory_index`,
        arguments: [
          tx.pure(indexBlobId),
          tx.pure(graphBlobId),
        ],
      });

      const result = await this.executeTransaction(tx, userAddress);
      const objectId = this.extractCreatedObjectId(result);
      
      return objectId;
    } catch (error) {
      this.logger.error(`Error creating memory index: ${error.message}`);
      throw new Error(`Failed to create memory index: ${error.message}`);
    }
  }

  /**
   * Update memory index
   */
  async updateMemoryIndex(
    indexId: string,
    userAddress: string,
    expectedVersion: number,
    newIndexBlobId: string,
    newGraphBlobId: string
  ): Promise<boolean> {
    try {
      const tx = new Transaction();
      
      tx.moveCall({
        target: `${this.packageId}::memory::update_memory_index`,
        arguments: [
          tx.object(indexId),
          tx.pure(expectedVersion),
          tx.pure(newIndexBlobId),
          tx.pure(newGraphBlobId),
        ],
      });

      await this.executeTransaction(tx, userAddress);
      return true;
    } catch (error) {
      this.logger.error(`Error updating memory index: ${error.message}`);
      throw new Error(`Failed to update memory index: ${error.message}`);
    }
  }

  /**
   * Get memory index
   */
  async getMemoryIndex(indexId: string): Promise<{
    owner: string;
    version: number;
    indexBlobId: string;
    graphBlobId: string;
  }> {
    try {
      const object = await this.client.getObject({
        id: indexId,
        options: {
          showContent: true,
        },
      });

      if (!object || !object.data || !object.data.content) {
        throw new Error(`Memory index ${indexId} not found`);
      }

      const content = object.data.content as any;
      return {
        owner: content.fields.owner,
        version: Number(content.fields.version),
        indexBlobId: content.fields.index_blob_id,
        graphBlobId: content.fields.graph_blob_id,
      };
    } catch (error) {
      this.logger.error(`Error getting memory index: ${error.message}`);
      throw new Error(`Failed to get memory index: ${error.message}`);
    }
  }

  /**
   * Get memories with a specific vector ID
   */
  async getMemoriesWithVectorId(userAddress: string, vectorId: number): Promise<{
    id: string;
    category: string;
    blobId: string;
  }[]> {
    try {
      // Query memories owned by this user
      const response = await this.client.queryTransactions({
        filter: {
          MoveFunction: {
            package: this.packageId,
            module: 'memory',
            function: 'create_memory_record',
          },
        },
        options: {
          showInput: true,
          showEffects: true,
          showEvents: true,
        },
      });

      const memories = [];

      // Process the transactions to find memories with matching vectorId
      for (const tx of response.data) {
        for (const event of tx.events || []) {
          if (event.type.includes('::memory::MemoryCreated')) {
            // Check if this memory has the target vectorId and belongs to the user
            const parsedData = event.parsedJson as any;
            if (
              parsedData && 
              parsedData.owner === userAddress &&
              Number(parsedData.vector_id) === vectorId
            ) {
              // Find the memory object created in this transaction
              const objectChanges = tx.objectChanges || [];
              const createdMemory = objectChanges.find(
                change => change.type === 'created' && 
                change.objectType.includes('::memory::Memory')
              );
              
              if (createdMemory) {
                // Get the full memory object to retrieve the blobId
                const memory = await this.client.getObject({
                  id: (createdMemory as any).objectId || '',
                  options: { showContent: true },
                });
                
                if (memory && memory.data && memory.data.content) {
                  const content = memory.data.content as any;
                  (memories as any).push({
                                      id: (createdMemory as any).objectId || '',
                  category: content.fields.category,
                  blobId: content.fields.blob_id,
                  });
                }
              }
            }
          }
        }
      }

      return memories;
    } catch (error) {
      this.logger.error(`Error getting memories with vector ID ${vectorId}: ${error.message}`);
      return [];
    }
  }

  /**
   * Get all memories for a user
   */
  async getUserMemories(userAddress: string): Promise<{
    id: string;
    category: string;
    blobId: string;
  }[]> {
    try {
      // Query all Memory objects owned by the user
      const response = await this.client.getOwnedObjects({
        owner: userAddress,
        filter: {
          StructType: `${this.packageId}::memory::Memory`
        },
        options: {
          showContent: true,
        },
      });

      const memories = [];

      for (const item of response.data) {
        if (!item.data?.content) continue;

        const content = item.data.content as any;
        (memories as any).push({
          id: item.data.objectId,
          category: content.fields.category,
          blobId: content.fields.blob_id,
          vectorId: Number(content.fields.vector_id)
        } as any);
      }

      return memories;
    } catch (error) {
      this.logger.error(`Error getting user memories: ${error.message}`);
      return [];
    }
  }

  /**
   * Get all memory indexes for a user
   */
  async getUserMemoryIndexes(userAddress: string): Promise<{
    id: string;
    owner: string;
    version: number;
    indexBlobId: string;
    graphBlobId: string;
  }[]> {
    try {
      // Query all MemoryIndex objects owned by the user
      const response = await this.client.getOwnedObjects({
        owner: userAddress,
        filter: {
          StructType: `${this.packageId}::memory::MemoryIndex`
        },
        options: {
          showContent: true,
        },
      });

      const indexes: Array<{
        id: string;
        owner: string;
        version: number;
        indexBlobId: string;
        graphBlobId: string;
      }> = [];

      for (const item of response.data) {
        if (!item.data?.content) continue;

        const content = item.data.content as any;
        indexes.push({
          id: item.data.objectId,
          owner: content.fields.owner,
          version: Number(content.fields.version),
          indexBlobId: content.fields.index_blob_id,
          graphBlobId: content.fields.graph_blob_id,
        });
      }

      // Sort by version descending to get the most recent first
      indexes.sort((a, b) => b.version - a.version);

      return indexes;
    } catch (error) {
      this.logger.error(`Error getting user memory indexes: ${error.message}`);
      return [];
    }
  }

  /**
   * Get a specific memory
   */
  async getMemory(memoryId: string): Promise<{
    id: string;
    owner: string;
    category: string;
    blobId: string;
    vectorId: number;
  }> {
    try {
      const object = await this.client.getObject({
        id: memoryId,
        options: {
          showContent: true,
        },
      });

      if (!object || !object.data || !object.data.content) {
        throw new Error(`Memory ${memoryId} not found`);
      }

      const content = object.data.content as any;
      return {
        id: memoryId,
        owner: content.fields.owner,
        category: content.fields.category,
        blobId: content.fields.blob_id,
        vectorId: Number(content.fields.vector_id),
      };
    } catch (error) {
      this.logger.error(`Error getting memory: ${error.message}`);
      throw new Error(`Failed to get memory: ${error.message}`);
    }
  }

  /**
   * Delete a memory
   */
  async deleteMemory(memoryId: string, userAddress: string): Promise<boolean> {
    try {
      // First verify the user owns the memory
      const memory = await this.getMemory(memoryId);
      if (memory.owner !== userAddress) {
        throw new Error('You do not own this memory');
      }
      
      // Create transaction to delete the memory
      const tx = new Transaction();
      
      // In a real implementation, you would call a delete function
      // Here we're transferring ownership to a burn address as an example
      tx.transferObjects(
        [tx.object(memoryId)],
        tx.pure('0x000000000000000000000000000000000000000000000000000000000000dead')
      );
      
      await this.executeTransaction(tx, userAddress);
      return true;
    } catch (error) {
      this.logger.error(`Error deleting memory: ${error.message}`);
      throw new Error(`Failed to delete memory: ${error.message}`);
    }
  }

  // ===== APP PERMISSION METHODS =====

  /**
   * Grant permission to an app
   */
  async grantAppPermission(
    userAddress: string,
    appAddress: string,
    dataIds: string[],
    expiresAt: number
  ): Promise<string> {
    try {
      const tx = new Transaction();
      
      // Convert data IDs to vector<vector<u8>>
      const dataIdBytes = dataIds.map(id => Array.from(new TextEncoder().encode(id)));
      
      tx.moveCall({
        target: `${this.packageId}::seal_access_control::grant_app_permission`,
        arguments: [
          tx.pure(appAddress),
          tx.pure(dataIdBytes),
          tx.pure(expiresAt.toString()),
          tx.object('0x6'), // Clock object
        ],
      });

      const result = await this.executeTransaction(tx, userAddress);
      const permissionId = this.extractCreatedObjectId(result);
      
      this.logger.log(`Granted permission ${permissionId} to app ${appAddress}`);
      
      return permissionId;
    } catch (error) {
      this.logger.error(`Error granting app permission: ${error.message}`);
      throw new Error(`Failed to grant app permission: ${error.message}`);
    }
  }

  /**
   * Revoke an app permission
   */
  async revokeAppPermission(
    permissionId: string,
    userAddress: string
  ): Promise<boolean> {
    try {
      const tx = new Transaction();
      
      tx.moveCall({
        target: `${this.packageId}::seal_access_control::revoke_app_permission`,
        arguments: [
          tx.object(permissionId),
        ],
      });

      await this.executeTransaction(tx, userAddress);
      
      this.logger.log(`Revoked permission ${permissionId}`);
      
      return true;
    } catch (error) {
      this.logger.error(`Error revoking app permission: ${error.message}`);
      throw new Error(`Failed to revoke app permission: ${error.message}`);
    }
  }

  /**
   * Get app permission details
   */
  async getAppPermission(permissionId: string): Promise<{
    user: string;
    app: string;
    grantedAt: number;
    expiresAt: number;
    revoked: boolean;
    dataIds: string[];
  }> {
    try {
      const object = await this.client.getObject({
        id: permissionId,
        options: {
          showContent: true,
        },
      });

      if (!object || !object.data || !object.data.content) {
        throw new Error(`Permission ${permissionId} not found`);
      }

      const content = object.data.content as any;
      const fields = content.fields;
      
      // Convert data IDs from bytes to strings
      const dataIds = fields.data_ids.map((idBytes: number[]) => 
        new TextDecoder().decode(new Uint8Array(idBytes))
      );
      
      return {
        user: fields.user,
        app: fields.app,
        grantedAt: Number(fields.granted_at),
        expiresAt: Number(fields.expires_at),
        revoked: fields.revoked,
        dataIds,
      };
    } catch (error) {
      this.logger.error(`Error getting app permission: ${error.message}`);
      throw new Error(`Failed to get app permission: ${error.message}`);
    }
  }

  /**
   * List all permissions granted by a user
   */
  async getUserAppPermissions(userAddress: string): Promise<Array<{
    id: string;
    app: string;
    grantedAt: number;
    expiresAt: number;
    revoked: boolean;
  }>> {
    try {
      // Query all AppPermission objects owned by the user
      const response = await this.client.getOwnedObjects({
        owner: userAddress,
        filter: {
          StructType: `${this.packageId}::seal_access_control::AppPermission`
        },
        options: {
          showContent: true,
        },
      });

      const permissions: Array<{
        id: string;
        app: string;
        grantedAt: number;
        expiresAt: number;
        revoked: boolean;
      }> = [];

      for (const item of response.data) {
        if (!item.data?.content) continue;

        const content = item.data.content as any;
        const fields = content.fields;
        
        permissions.push({
          id: item.data.objectId,
          app: fields.app,
          grantedAt: Number(fields.granted_at),
          expiresAt: Number(fields.expires_at),
          revoked: fields.revoked,
        });
      }

      return permissions;
    } catch (error) {
      this.logger.error(`Error getting user app permissions: ${error.message}`);
      return [];
    }
  }

  // Helper methods
  private async executeTransaction(tx: Transaction, sender: string) {
    // Set the sender to the actual user address
    tx.setSender(sender);
    
    this.logger.log(`Executing transaction for user ${sender}`);
    
    // For demonstration purposes in development, we can use the admin keypair
    // But we use the user's address as sender
    try {
      return await this.client.signAndExecuteTransaction({
        transactionBlock: tx,
        signer: this.adminKeypair,
        options: {
          showEffects: true,
          showEvents: true,
          showObjectChanges: true,
        },
        requestType: 'WaitForLocalExecution',
      });
    } catch (error) {
      this.logger.error(`Transaction execution failed: ${error.message}`);
      throw error;
    }
  }

  private extractCreatedObjectId(result: any): string {
    try {
      // Extract the object ID from the transaction result
      const created = result.objectChanges.filter(
        change => change.type === 'created'
      )[0];
      
      return created?.objectId || '';
    } catch (error) {
      return '';
    }
  }

  private deserializeMessages(serializedMessages: any): ChatMessage[] {
    try {
      // Convert Sui Move vector to TypeScript array
      return serializedMessages.map(msg => ({
        role: msg.fields.role,
        content: msg.fields.content,
      }));
    } catch (error) {
      return [];
    }
  }
}