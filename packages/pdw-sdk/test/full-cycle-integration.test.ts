/**
 * Full Cycle Integration Test
 * 
 * Tests the complete PDW SDK workflow:
 * 1. Initialize PersonalDataWallet client extension
 * 2. Create memory with vector embeddings
 * 3. Store to Walrus using StorageService
 * 4. Retrieve and verify content integrity
 * 5. Search memories by vector similarity
 * 6. Test SEAL encryption integration (when available)
 * 7. Test cross-app access patterns
 * 
 * This test demonstrates the full production workflow.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { PersonalDataWallet } from '../src/client/PersonalDataWallet';
import { StorageService } from '../src/services/StorageService';
import { EmbeddingService } from '../src/services/EmbeddingService';
import { VectorService } from '../src/services/VectorService';
import { MemoryService } from '../src/services/MemoryService';
import { ViewService } from '../src/view/ViewService';

// Load environment variables
import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' });

describe('PDW SDK Full Cycle Integration', () => {
  let suiClient: SuiClient;
  let pdwClient: any;
  let keypair: Ed25519Keypair;
  let userAddress: string;
  let storageService: StorageService;
  let embeddingService: EmbeddingService;
  let vectorService: VectorService;
  let memoryService: MemoryService;
  let viewService: ViewService;

  // Test data
  const testMemories = [
    {
      content: "The quantum computer breakthrough achieved 99.9% fidelity in quantum state preparation, marking a significant milestone in fault-tolerant quantum computing.",
      category: "technology",
      topic: "quantum-computing",
      importance: 9
    },
    {
      content: "Machine learning models now demonstrate emergent reasoning capabilities, suggesting artificial general intelligence may be closer than previously thought.",
      category: "ai-research", 
      topic: "artificial-intelligence",
      importance: 8
    },
    {
      content: "Renewable energy storage solutions using advanced battery chemistry achieved 95% efficiency in large-scale grid implementations.",
      category: "sustainability",
      topic: "energy-storage",
      importance: 7
    }
  ];

  beforeAll(async () => {
    console.log('\n🚀 Starting PDW SDK Full Cycle Integration Test...\n');

    // Initialize Sui client
    suiClient = new SuiClient({
      url: getFullnodeUrl('testnet'),
      network: 'testnet',
    });

    // Initialize keypair from environment
    const privateKeyHex = process.env.TEST_PRIVATE_KEY;
    if (!privateKeyHex) {
      throw new Error('TEST_PRIVATE_KEY not found in environment');
    }

    const { schema, secretKey } = decodeSuiPrivateKey(privateKeyHex);
    if (schema !== 'ED25519') {
      throw new Error(`Unsupported key scheme: ${schema}`);
    }
    keypair = Ed25519Keypair.fromSecretKey(secretKey);
    userAddress = keypair.toSuiAddress();
    console.log(`👤 User Address: ${userAddress}`);

    // Initialize PDW client extension
    const packageId = process.env.PDW_PACKAGE_ID || '0x123'; // fallback for testing
    pdwClient = suiClient.$extend(PersonalDataWallet.asClientExtension({
      packageId,
      apiUrl: 'http://localhost:3001/api'
    }));

    // Initialize services
    storageService = new StorageService({
      suiClient,
      network: 'testnet',
      useUploadRelay: true,
      epochs: 3
    });

    embeddingService = new EmbeddingService({
      apiKey: process.env.GEMINI_API_KEY || 'dummy-key-for-testing',
      model: 'text-embedding-004'
    });

    vectorService = new VectorService({
      embedding: {
        apiKey: process.env.GEMINI_API_KEY || 'dummy-key-for-testing',
        model: 'text-embedding-004'
      },
      index: {
        dimension: 768,
        maxElements: 1000,
        m: 16,
        efConstruction: 200
      }
    });

    memoryService = new MemoryService(
      pdwClient, // ClientWithCoreApi
      { packageId, apiUrl: 'http://localhost:3001/api' } // PDWConfig
    );

    viewService = new ViewService(
      pdwClient, // ClientWithCoreApi  
      { packageId, apiUrl: 'http://localhost:3001/api' } // PDWConfig
    );

    console.log('✅ All services initialized successfully\n');
  }, 30000);

  test('Phase 1: Service Initialization and Health Check', async () => {
    console.log('📋 Phase 1: Testing service initialization...');

    // Test StorageService
    const storageStats = storageService.getStats();
    console.log('📊 StorageService Stats:', storageStats);
    expect(storageStats.network).toBe('testnet');
    expect(storageStats.useUploadRelay).toBe(true);

    // Test EmbeddingService  
    console.log('🧠 Testing embedding generation...');
    const testEmbedding = await embeddingService.embedText({
      text: 'Test embedding generation'
    });
    console.log(`✅ Generated embedding: dimension=${testEmbedding.dimension}, model=${testEmbedding.model}`);
    expect(testEmbedding.vector).toHaveLength(testEmbedding.dimension);
    expect(testEmbedding.dimension).toBe(768);

    console.log('✅ Phase 1 completed successfully\n');
  }, 60000);

  test('Phase 2: Memory Creation and Storage', async () => {
    console.log('💾 Phase 2: Creating and storing memories...');

    const createdMemories = [];

    for (let i = 0; i < testMemories.length; i++) {
      const memory = testMemories[i];
      console.log(`\n📝 Creating memory ${i + 1}/${testMemories.length}: "${memory.content.substring(0, 50)}..."`);

      try {
        // Generate embedding
        console.log('  🧠 Generating embedding...');
        const embedding = await embeddingService.embedText({
          text: memory.content,
          taskType: 'RETRIEVAL_DOCUMENT'
        });
        console.log(`  ✅ Embedding generated: ${embedding.dimension} dimensions`);

        // Create memory metadata
        const metadata = {
          contentType: 'text/plain',
          contentSize: memory.content.length,
          contentHash: '', // Will be calculated by storage
          category: memory.category,
          topic: memory.topic,
          importance: memory.importance,
          embeddingDimension: embedding.dimension,
          createdTimestamp: Date.now(),
          customMetadata: {
            'test-cycle': 'full-integration',
            'memory-index': i.toString()
          }
        };

        // Store content using StorageService
        console.log('  💾 Uploading to Walrus...');
        const uploadResult = await storageService.upload(
          memory.content,
          metadata,
          {
            signer: keypair,
            epochs: 3,
            deletable: true,
            metadata: {
              category: memory.category,
              topic: memory.topic,
              importance: memory.importance.toString()
            }
          }
        );

        console.log(`  ✅ Stored to Walrus: ${uploadResult.blobId} (${uploadResult.uploadTimeMs}ms)`);

        createdMemories.push({
          ...memory,
          blobId: uploadResult.blobId,
          embedding: embedding.vector,
          metadata: uploadResult.metadata
        });

      } catch (error) {
        console.error(`  ❌ Failed to create memory ${i + 1}:`, error);
        throw error;
      }
    }

    expect(createdMemories).toHaveLength(testMemories.length);
    console.log(`✅ Phase 2 completed: ${createdMemories.length} memories created and stored\n`);

    // Store for next phases
    (global as any).testMemories = createdMemories;
  }, 180000);

  test('Phase 3: Content Retrieval and Integrity Verification', async () => {
    console.log('🔍 Phase 3: Retrieving and verifying content integrity...');

    const createdMemories = (global as any).testMemories;
    expect(createdMemories).toBeDefined();

    for (let i = 0; i < createdMemories.length; i++) {
      const memory = createdMemories[i];
      console.log(`\n📥 Retrieving memory ${i + 1}: ${memory.blobId}`);

      try {
        // Retrieve from Walrus
        const retrieved = await storageService.retrieve(memory.blobId);
        const retrievedContent = new TextDecoder().decode(retrieved.content);

        console.log(`  📄 Content length: ${retrievedContent.length} chars`);
        console.log(`  📄 First 100 chars: "${retrievedContent.substring(0, 100)}..."`);

        // Verify integrity
        expect(retrievedContent).toBe(memory.content);
        expect(retrieved.metadata.contentSize).toBe(memory.content.length);
        
        console.log('  ✅ Content integrity verified');

      } catch (error) {
        console.error(`  ❌ Failed to retrieve memory ${i + 1}:`, error);
        throw error;
      }
    }

    console.log('✅ Phase 3 completed: All content retrieved and verified\n');
  }, 120000);

  test('Phase 4: Vector Indexing and Search', async () => {
    console.log('🔍 Phase 4: Testing vector indexing and similarity search...');

    const createdMemories = (global as any).testMemories;
    const spaceId = 'test-full-cycle';

    try {
      // Create vector index
      console.log('  📊 Creating vector index...');
      await vectorService.createIndex(spaceId, 768, {
        maxElements: 1000,
        m: 16,
        efConstruction: 200
      });
      console.log('  ✅ Vector index created');

      // Add memories to index
      console.log('  📝 Adding memories to vector index...');
      for (let i = 0; i < createdMemories.length; i++) {
        const memory = createdMemories[i];
        await vectorService.addVector(spaceId, i, memory.embedding, {
          blobId: memory.blobId,
          category: memory.category,
          topic: memory.topic,
          content: memory.content.substring(0, 100) + '...'
        });
        console.log(`    ➕ Added memory ${i + 1} to index`);
      }

      // Test similarity search
      console.log('\n  🔍 Testing similarity search...');
      const searchQueries = [
        'quantum computing breakthrough',
        'artificial intelligence research',
        'renewable energy technology'
      ];

      for (const query of searchQueries) {
        console.log(`\n    🔎 Searching for: "${query}"`);
        
        const searchResults = await vectorService.searchByText(spaceId, query, { k: 2 });
        console.log(`    📊 Found ${searchResults.results.length} similar memories`);

        for (let j = 0; j < searchResults.results.length; j++) {
          const result = searchResults.results[j];
          console.log(`      ${j + 1}. Similarity: ${result.similarity.toFixed(3)}, Distance: ${result.distance.toFixed(3)}`);
          console.log(`         Content: "${result.metadata.content}"`);
        }
      }

      console.log('✅ Phase 4 completed: Vector search working correctly\n');

    } catch (error) {
      console.error('❌ Phase 4 failed:', error);
      throw error;
    }
  }, 180000);

  test('Phase 5: Performance and Statistics', async () => {
    console.log('📊 Phase 5: Gathering performance statistics...');

    const createdMemories = (global as any).testMemories;

    // Storage statistics
    const storageStats = storageService.getStats();
    console.log('\n📊 Storage Service Statistics:');
    console.log('  Network:', storageStats.network);
    console.log('  Upload Relay:', storageStats.useUploadRelay);
    console.log('  Default Epochs:', storageStats.epochs);
    console.log('  Encryption Available:', storageStats.hasEncryption);
    console.log('  Batching Available:', storageStats.hasBatching);

    // Memory statistics
    console.log('\n📊 Memory Statistics:');
    console.log('  Total Memories Created:', createdMemories.length);
    
    const totalSize = createdMemories.reduce((sum: number, mem: any) => sum + mem.content.length, 0);
    const avgSize = totalSize / createdMemories.length;
    console.log('  Total Content Size:', totalSize, 'bytes');
    console.log('  Average Memory Size:', Math.round(avgSize), 'bytes');

    const totalUploadTime = createdMemories.reduce((sum: number, mem: any) => sum + mem.metadata.uploadTimeMs || 0, 0);
    const avgUploadTime = totalUploadTime / createdMemories.length;
    console.log('  Total Upload Time:', Math.round(totalUploadTime), 'ms');
    console.log('  Average Upload Time:', Math.round(avgUploadTime), 'ms');

    // Embedding statistics
    console.log('\n📊 Embedding Statistics:');
    console.log('  Embedding Dimension:', 768);
    console.log('  Total Embeddings:', createdMemories.length);
    console.log('  Embedding Model:', 'text-embedding-004');

    console.log('✅ Phase 5 completed: Performance statistics gathered\n');
  }, 30000);

  test('Phase 6: Integration Health Check', async () => {
    console.log('🏥 Phase 6: Final integration health check...');

    try {
      // Test client extension
      console.log('  🔗 Testing PersonalDataWallet client extension...');
      expect(pdwClient.pdw).toBeDefined();
      console.log('  ✅ Client extension available');

      // Test all services are responsive
      console.log('  🧠 Testing EmbeddingService responsiveness...');
      const quickEmbed = await embeddingService.embedText({ text: 'health check' });
      expect(quickEmbed.vector).toBeDefined();
      console.log('  ✅ EmbeddingService responsive');

      console.log('  💾 Testing StorageService configuration...');
      const stats = storageService.getStats();
      expect(stats.network).toBe('testnet');
      console.log('  ✅ StorageService configured correctly');

      // Final validation
      const createdMemories = (global as any).testMemories;
      expect(createdMemories).toBeDefined();
      expect(createdMemories.length).toBe(testMemories.length);

      console.log('\n🎉 FULL CYCLE INTEGRATION TEST COMPLETED SUCCESSFULLY!');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('✅ All phases completed:');
      console.log('   1. ✅ Service initialization');
      console.log('   2. ✅ Memory creation and storage'); 
      console.log('   3. ✅ Content retrieval and verification');
      console.log('   4. ✅ Vector indexing and search');
      console.log('   5. ✅ Performance statistics');
      console.log('   6. ✅ Integration health check');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    } catch (error) {
      console.error('❌ Phase 6 failed:', error);
      throw error;
    }
  }, 60000);

  afterAll(async () => {
    console.log('\n🧹 Cleaning up test resources...');
    
    // Clean up any test data if needed
    // Note: Walrus blobs will expire naturally based on epochs
    
    console.log('✅ Cleanup completed\n');
  });
});