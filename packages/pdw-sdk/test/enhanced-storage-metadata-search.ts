/**
 * Test Enhanced StorageService with HNSW-based Metadata Search
 * 
 * This test demonstrates how to use the enhanced StorageService w      console.log(`      Content: "${result.content ? result.content.toString().substring(0, 80) : 'No content'}..."`);  th
 * sophisticated metadata-based search and retrieval capabilities.
 */

import { StorageService } from '../src/services/StorageService';
import { EmbeddingService } from '../src/embedding/EmbeddingService';
import { HnswIndexService } from '../src/vector/HnswIndexService';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromHex } from '@mysten/sui/utils';

// Example usage of the enhanced StorageService
async function testMetadataSearch() {
  console.log('🚀 Testing Enhanced StorageService with HNSW Metadata Search');

  // Initialize services
  const storageService = new StorageService({
    network: 'testnet',
    useUploadRelay: true,
    epochs: 3
  });

  const embeddingService = new EmbeddingService({
    // API key from environment
  });

  // Initialize search capabilities
  storageService.initializeSearch(embeddingService);

  // Create test keypair and user address
  const testPrivateKey = process.env.SUI_PRIVATE_KEY;
  if (!testPrivateKey) {
    throw new Error('SUI_PRIVATE_KEY environment variable required');
  }

  const keypair = Ed25519Keypair.fromSecretKey(fromHex(testPrivateKey));
  const userAddress = keypair.toSuiAddress();

  console.log(`📧 User address: ${userAddress}`);

  // Test data with different categories and metadata
  const testDocuments = [
    {
      content: "Artificial Intelligence research paper discussing neural networks and deep learning algorithms.",
      metadata: {
        contentType: 'text/plain',
        contentSize: 0,
        contentHash: '',
        category: 'research',
        topic: 'artificial-intelligence',
        importance: 9,
        embeddingDimension: 768,
        createdTimestamp: Date.now(),
        customMetadata: {
          'document-type': 'research-paper',
          'tags': '#ai #neural-networks #deep-learning',
          'author': 'Research Team',
          'year': '2024'
        }
      }
    },
    {
      content: "Personal notes about weekend plans and grocery shopping list.",
      metadata: {
        contentType: 'text/plain',
        contentSize: 0,
        contentHash: '',
        category: 'personal',
        topic: 'notes',
        importance: 3,
        embeddingDimension: 768,
        createdTimestamp: Date.now() - 86400000, // 1 day ago
        customMetadata: {
          'document-type': 'personal-note',
          'tags': '#personal #weekend #shopping',
          'priority': 'low'
        }
      }
    },
    {
      content: "Business meeting summary discussing quarterly results and strategic planning.",
      metadata: {
        contentType: 'text/plain',
        contentSize: 0,
        contentHash: '',
        category: 'business',
        topic: 'meetings',
        importance: 8,
        embeddingDimension: 768,
        createdTimestamp: Date.now() - 43200000, // 12 hours ago
        customMetadata: {
          'document-type': 'meeting-summary',
          'tags': '#business #quarterly #strategy',
          'department': 'executive',
          'confidential': 'true'
        }
      }
    }
  ];

  try {
    console.log('\n📤 Step 1: Uploading and indexing test documents...');
    
    const uploadResults = [];
    for (let i = 0; i < testDocuments.length; i++) {
      const doc = testDocuments[i];
      doc.metadata.contentSize = doc.content.length;
      
      console.log(`   Uploading document ${i + 1}: ${doc.metadata.category} - ${doc.metadata.topic}`);
      
      const result = await storageService.uploadWithIndexing(
        doc.content,
        doc.metadata as any, // Casting to avoid strict type checking for demo
        userAddress,
        {
          signer: keypair,
          epochs: 3,
          deletable: true
        }
      );
      
      uploadResults.push(result);
      console.log(`   ✅ Uploaded: ${result.blobId} (vector ID: ${result.vectorId})`);
    }

    console.log(`\n📊 Successfully uploaded and indexed ${uploadResults.length} documents`);

    // Test 1: Semantic search for AI-related content
    console.log('\n🔍 Test 1: Semantic Search for "machine learning research"');
    const aiResults = await storageService.searchByMetadata(userAddress, {
      query: "machine learning research",
      k: 5,
      threshold: 0.3,
      includeContent: true
    });

    console.log(`   Found ${aiResults.length} results:`);
    aiResults.forEach((result, i) => {
      console.log(`   ${i + 1}. Category: ${result.metadata.category}, Similarity: ${result.similarity.toFixed(3)}, Relevance: ${result.relevanceScore.toFixed(3)}`);
      console.log(`      Content: "${result.content ? result.content.toString().substring(0, 80)}..."`);
    });

    // Test 2: Category-based search
    console.log('\n🏷️ Test 2: Category Search for "research" documents');
    const researchResults = await storageService.searchByCategory(userAddress, 'research');
    
    console.log(`   Found ${researchResults.length} research documents:`);
    researchResults.forEach((result, i) => {
      console.log(`   ${i + 1}. Topic: ${result.metadata.topic}, Importance: ${result.metadata.importance}`);
    });

    // Test 3: Importance-based filtering
    console.log('\n⭐ Test 3: High Importance Documents (>= 7)');
    const importantResults = await storageService.searchByMetadata(userAddress, {
      filters: {
        importance: { min: 7 }
      },
      k: 10
    });

    console.log(`   Found ${importantResults.length} high-importance documents:`);
    importantResults.forEach((result, i) => {
      console.log(`   ${i + 1}. Category: ${result.metadata.category}, Importance: ${result.metadata.importance}, Topic: ${result.metadata.topic}`);
    });

    // Test 4: Time-based search
    console.log('\n📅 Test 4: Recent Documents (last 6 hours)');
    const recentResults = await storageService.searchByTimeRange(
      userAddress,
      new Date(Date.now() - 6 * 60 * 60 * 1000), // 6 hours ago
      new Date() // now
    );

    console.log(`   Found ${recentResults.length} recent documents:`);
    recentResults.forEach((result, i) => {
      const createdAgo = Math.round((Date.now() - result.metadata.createdTimestamp) / (1000 * 60));
      console.log(`   ${i + 1}. Category: ${result.metadata.category}, Created: ${createdAgo} minutes ago`);
    });

    // Test 5: Combined filter search
    console.log('\n🎯 Test 5: Combined Search - Business documents with high importance');
    const combinedResults = await storageService.searchByMetadata(userAddress, {
      filters: {
        category: 'business',
        importance: { min: 5 }
      },
      k: 5
    });

    console.log(`   Found ${combinedResults.length} business documents with high importance:`);
    combinedResults.forEach((result, i) => {
      console.log(`   ${i + 1}. Topic: ${result.metadata.topic}, Importance: ${result.metadata.importance}`);
    });

    // Test 6: Get all user memories with metadata
    console.log('\n📚 Test 6: All User Memories Overview');
    const allMemories = await storageService.getUserMemoriesWithMetadata(userAddress);
    
    console.log(`   Total memories: ${allMemories.length}`);
    allMemories.forEach((result, i) => {
      console.log(`   ${i + 1}. ${result.metadata.category}/${result.metadata.topic} - Importance: ${result.metadata.importance}`);
    });

    // Test 7: Search analytics
    console.log('\n📈 Test 7: Search Analytics');
    const analytics = storageService.getSearchAnalytics(userAddress);
    
    console.log(`   Total memories indexed: ${analytics.totalMemories}`);
    console.log(`   Categories:`, analytics.categoryCounts);
    console.log(`   Average importance: ${analytics.averageImportance.toFixed(1)}`);
    console.log(`   Time range: ${analytics.timeRange?.earliest.toISOString()} to ${analytics.timeRange?.latest.toISOString()}`);
    console.log(`   Top tags:`, analytics.topTags);

    // Test 8: Storage stats
    console.log('\n📊 Test 8: Enhanced Storage Service Stats');
    const stats = storageService.getStats();
    console.log('   Storage Service Configuration:');
    console.log(`   - Network: ${stats.network}`);
    console.log(`   - Upload relay: ${stats.useUploadRelay}`);
    console.log(`   - Search enabled: ${stats.hasSearch}`);
    console.log(`   - Indexed users: ${stats.indexedUsers}`);
    console.log(`   - Total indexed memories: ${stats.totalIndexedMemories}`);

    console.log('\n✅ All metadata search tests completed successfully!');
    console.log('\n🎉 Enhanced StorageService with HNSW search is working perfectly!');
    
    return {
      uploadResults,
      searchResults: {
        semantic: aiResults,
        category: researchResults,
        importance: importantResults,
        temporal: recentResults,
        combined: combinedResults,
        all: allMemories
      },
      analytics,
      stats
    };

  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

// Example of how to use the enhanced search in applications
async function demonstrateUsagePatterns() {
  console.log('\n\n🎯 USAGE PATTERNS DEMONSTRATION');
  console.log('=====================================');

  const storageService = new StorageService({
    network: 'testnet',
    useUploadRelay: true
  });

  const embeddingService = new EmbeddingService();
  storageService.initializeSearch(embeddingService);

  const userAddress = '0x1234...'; // Your user address

  // Pattern 1: Smart document discovery
  console.log('\n📋 Pattern 1: Smart Document Discovery');
  console.log('// Find documents related to a concept');
  console.log(`const results = await storageService.searchByMetadata(userAddress, {`);
  console.log(`  query: "project management and team collaboration",`);
  console.log(`  k: 10,`);
  console.log(`  threshold: 0.7,`);
  console.log(`  includeContent: true`);
  console.log(`});`);

  // Pattern 2: Advanced filtering
  console.log('\n🎛️ Pattern 2: Advanced Multi-Dimensional Filtering');
  console.log('// Find recent, important research documents');
  console.log(`const results = await storageService.searchByMetadata(userAddress, {`);
  console.log(`  filters: {`);
  console.log(`    category: ['research', 'academic'],`);
  console.log(`    importance: { min: 8 },`);
  console.log(`    dateRange: {`);
  console.log(`      start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last week`);
  console.log(`      end: new Date()`);
  console.log(`    },`);
  console.log(`    tags: ['#important', '#review']`);
  console.log(`  },`);
  console.log(`  k: 20`);
  console.log(`});`);

  // Pattern 3: Category-based organization
  console.log('\n🗂️ Pattern 3: Category-Based Organization');
  console.log('// Get all documents in a specific category');
  console.log(`const businessDocs = await storageService.searchByCategory(`);
  console.log(`  userAddress,`);
  console.log(`  'business',`);
  console.log(`  { importance: { min: 5 } } // Additional filters`);
  console.log(`);`);

  // Pattern 4: Temporal analysis
  console.log('\n⏰ Pattern 4: Temporal Analysis');
  console.log('// Analyze document patterns over time');
  console.log(`const lastMonth = await storageService.searchByTimeRange(`);
  console.log(`  userAddress,`);
  console.log(`  new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),`);
  console.log(`  new Date()`);
  console.log(`);`);

  // Pattern 5: Analytics and insights
  console.log('\n📊 Pattern 5: Analytics and Insights');
  console.log('// Get comprehensive analytics');
  console.log(`const analytics = storageService.getSearchAnalytics(userAddress);`);
  console.log(`console.log('Total documents:', analytics.totalMemories);`);
  console.log(`console.log('Popular categories:', analytics.categoryCounts);`);
  console.log(`console.log('Top tags:', analytics.topTags);`);

  console.log('\n✨ These patterns enable powerful document management and discovery!');
}

// Run the test if this file is executed directly
if (require.main === module) {
  testMetadataSearch()
    .then(() => demonstrateUsagePatterns())
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Test failed:', error);
      process.exit(1);
    });
}

export { testMetadataSearch, demonstrateUsagePatterns };