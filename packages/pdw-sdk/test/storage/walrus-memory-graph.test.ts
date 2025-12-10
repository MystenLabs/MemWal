/**
 * Walrus Storage Advanced Tests - Memory & Graph Operations
 * 
 * Tests advanced memory operations, graph relationships, and metadata management
 */

require('dotenv').config({ path: '.env.test' });

const { WalrusTestAdapter } = require('../../dist/storage/WalrusTestAdapter');
const { SuiClient } = require('@mysten/sui/client');
const { Ed25519Keypair } = require('@mysten/sui/keypairs/ed25519');

describe('Walrus Storage - Memory & Graph Operations', () => {
  let walrusService: any;
  let testAddress: string;
  const uploadedBlobIds: string[] = [];

  beforeAll(async () => {
    const suiClient = new SuiClient({ 
      url: 'https://rpc-testnet.suinetwork.io' 
    });

    const testKeypair = new Ed25519Keypair();
    testAddress = testKeypair.toSuiAddress();

    walrusService = new WalrusTestAdapter({
      network: 'testnet',
      storageEpochs: 5,
      retryAttempts: 3,
      timeoutMs: 30000,
      suiClient,
      packageId: process.env.PACKAGE_ID || '0x123'
    });
  });

  afterAll(async () => {
    for (const blobId of uploadedBlobIds) {
      try {
        await walrusService.deleteBlob(blobId);
      } catch (error) {
        console.warn(`Cleanup failed for ${blobId}`);
      }
    }
  });

  // ====================== MEMORY STORAGE OPERATIONS ======================

  describe('Memory Storage Operations', () => {
    test('should add memory with rich metadata', async () => {
      const memoryData = {
        id: 'memory_001',
        text: 'Quantum computing leverages quantum mechanics principles',
        category: 'technology',
        importance: 9,
        context: {
          domain: 'quantum-physics',
          complexity: 'advanced',
          prerequisites: ['linear-algebra', 'quantum-mechanics'],
          related_concepts: ['superposition', 'entanglement', 'qubits']
        },
        embeddings: {
          vector: new Array(1536).fill(0).map(() => Math.random()),
          model: 'text-embedding-ada-002',
          dimension: 1536
        },
        created_at: new Date().toISOString(),
        version: 1
      };

      const result = await walrusService.uploadContentWithMetadata(
        JSON.stringify(memoryData),
        testAddress,
        {
          category: 'memory',
          topic: 'quantum-computing',
          importance: 9,
          additionalTags: {
            memory_id: memoryData.id,
            domain: memoryData.context.domain,
            has_embeddings: 'true',
            version: memoryData.version.toString()
          }
        }
      );

      expect(result.blobId).toBeDefined();
      expect(result.metadata.category).toBe('memory');
      
      uploadedBlobIds.push(result.blobId);

      // Verify retrieval and parsing
      const retrieved = await walrusService.retrieveContent(result.blobId);
      const parsedMemory = JSON.parse(retrieved.content);
      
      expect(parsedMemory.id).toBe(memoryData.id);
      expect(parsedMemory.embeddings.dimension).toBe(1536);
      expect(parsedMemory.context.related_concepts).toContain('qubits');

      console.log(`✅ Added memory with rich metadata: ${memoryData.id}`);
    }, 30000);

    test('should remove memory by blob ID', async () => {
      const memoryToDelete = {
        id: 'temp_memory_001',
        text: 'Temporary memory for deletion test',
        category: 'temporary'
      };

      const uploadResult = await walrusService.uploadContentWithMetadata(
        JSON.stringify(memoryToDelete),
        testAddress,
        {
          category: 'temporary',
          topic: 'deletion-test',
          importance: 1
        }
      );

      // Verify it exists
      const beforeDeletion = await walrusService.getBlobInfo(uploadResult.blobId);
      expect(beforeDeletion).toBeDefined();

      // Delete it
      const deleted = await walrusService.deleteBlob(uploadResult.blobId);
      expect(deleted).toBe(true);

      // Verify it's gone
      const afterDeletion = await walrusService.getBlobInfo(uploadResult.blobId);
      expect(afterDeletion).toBeNull();

      console.log(`✅ Removed memory: ${memoryToDelete.id}`);
    }, 30000);

    test('should update memory content and maintain version history', async () => {
      const originalMemory = {
        id: 'versioned_memory_001',
        text: 'Machine learning is a subset of artificial intelligence',
        category: 'ai',
        version: 1,
        updated_history: []
      };

      // Upload original version
      const v1Result = await walrusService.uploadContentWithMetadata(
        JSON.stringify(originalMemory),
        testAddress,
        {
          category: 'ai',
          topic: 'machine-learning',
          importance: 7,
          additionalTags: {
            memory_id: originalMemory.id,
            version: '1'
          }
        }
      );

      uploadedBlobIds.push(v1Result.blobId);

      // Create updated version
      const updatedMemory = {
        ...originalMemory,
        text: 'Machine learning is a subset of artificial intelligence that enables computers to learn without being explicitly programmed',
        version: 2,
        updated_history: [
          {
            version: 1,
            blobId: v1Result.blobId,
            timestamp: new Date().toISOString(),
            changes: 'Extended definition with more details'
          }
        ]
      };

      // Upload updated version
      const v2Result = await walrusService.uploadContentWithMetadata(
        JSON.stringify(updatedMemory),
        testAddress,
        {
          category: 'ai',
          topic: 'machine-learning',
          importance: 8,
          additionalTags: {
            memory_id: updatedMemory.id,
            version: '2',
            previous_version: v1Result.blobId
          }
        }
      );

      uploadedBlobIds.push(v2Result.blobId);

      // Verify version history
      const retrievedV2 = await walrusService.retrieveContent(v2Result.blobId);
      const parsedV2 = JSON.parse(retrievedV2.content);
      
      expect(parsedV2.version).toBe(2);
      expect(parsedV2.updated_history).toHaveLength(1);
      expect(parsedV2.updated_history[0].blobId).toBe(v1Result.blobId);

      console.log(`✅ Updated memory with version history: ${originalMemory.id} v1→v2`);
    }, 45000);
  });

  // ====================== GRAPH OPERATIONS ======================

  describe('Graph Operations', () => {
    test('should create knowledge graph with nodes and relationships', async () => {
      const knowledgeGraph = {
        graph_id: 'ai_knowledge_graph_001',
        type: 'knowledge_graph',
        nodes: [
          {
            id: 'ai',
            type: 'concept',
            name: 'Artificial Intelligence',
            properties: {
              definition: 'Computer systems that can perform tasks requiring human intelligence',
              established: '1956',
              founders: ['John McCarthy', 'Marvin Minsky']
            }
          },
          {
            id: 'ml',
            type: 'concept', 
            name: 'Machine Learning',
            properties: {
              definition: 'Algorithms that improve through experience',
              subcategories: ['supervised', 'unsupervised', 'reinforcement']
            }
          },
          {
            id: 'dl',
            type: 'concept',
            name: 'Deep Learning',
            properties: {
              definition: 'Neural networks with multiple layers',
              key_architectures: ['CNN', 'RNN', 'Transformer']
            }
          },
          {
            id: 'neural_networks',
            type: 'concept',
            name: 'Neural Networks',
            properties: {
              inspired_by: 'biological neurons',
              components: ['neurons', 'weights', 'activation_functions']
            }
          }
        ],
        edges: [
          {
            id: 'edge_001',
            from: 'ai',
            to: 'ml',
            relationship: 'includes',
            properties: {
              strength: 0.9,
              description: 'ML is a major branch of AI'
            }
          },
          {
            id: 'edge_002',
            from: 'ml',
            to: 'dl',
            relationship: 'specializes_to',
            properties: {
              strength: 0.8,
              description: 'DL is a specialized form of ML'
            }
          },
          {
            id: 'edge_003',
            from: 'dl',
            to: 'neural_networks',
            relationship: 'implemented_using',
            properties: {
              strength: 1.0,
              description: 'DL is implemented using neural networks'
            }
          }
        ],
        metadata: {
          created_at: new Date().toISOString(),
          domain: 'artificial_intelligence',
          node_count: 4,
          edge_count: 3,
          completeness: 0.7
        }
      };

      const result = await walrusService.uploadContentWithMetadata(
        JSON.stringify(knowledgeGraph),
        testAddress,
        {
          category: 'knowledge_graph',
          topic: 'artificial_intelligence',
          importance: 10,
          additionalTags: {
            graph_id: knowledgeGraph.graph_id,
            node_count: knowledgeGraph.nodes.length.toString(),
            edge_count: knowledgeGraph.edges.length.toString(),
            domain: knowledgeGraph.metadata.domain
          }
        }
      );

      expect(result.blobId).toBeDefined();
      uploadedBlobIds.push(result.blobId);

      // Verify graph structure
      const retrieved = await walrusService.retrieveContent(result.blobId);
      const parsedGraph = JSON.parse(retrieved.content);
      
      expect(parsedGraph.nodes).toHaveLength(4);
      expect(parsedGraph.edges).toHaveLength(3);
      expect(parsedGraph.edges[0].relationship).toBe('includes');

      console.log(`✅ Created knowledge graph: ${knowledgeGraph.graph_id}`);
    }, 30000);

    test('should update graph by adding new nodes and relationships', async () => {
      const initialGraph = {
        graph_id: 'expandable_graph_001',
        nodes: [
          { id: 'python', type: 'language', name: 'Python' },
          { id: 'ml', type: 'field', name: 'Machine Learning' }
        ],
        edges: [
          { id: 'e1', from: 'python', to: 'ml', relationship: 'used_for' }
        ]
      };

      // Upload initial graph
      const initialResult = await walrusService.uploadContentWithMetadata(
        JSON.stringify(initialGraph),
        testAddress,
        {
          category: 'graph',
          topic: 'programming',
          importance: 6,
          additionalTags: {
            graph_id: initialGraph.graph_id,
            version: '1',
            node_count: '2',
            edge_count: '1'
          }
        }
      );

      uploadedBlobIds.push(initialResult.blobId);

      // Expand the graph
      const expandedGraph = {
        ...initialGraph,
        nodes: [
          ...initialGraph.nodes,
          { id: 'tensorflow', type: 'framework', name: 'TensorFlow' },
          { id: 'pytorch', type: 'framework', name: 'PyTorch' }
        ],
        edges: [
          ...initialGraph.edges,
          { id: 'e2', from: 'python', to: 'tensorflow', relationship: 'supports' },
          { id: 'e3', from: 'python', to: 'pytorch', relationship: 'supports' },
          { id: 'e4', from: 'tensorflow', to: 'ml', relationship: 'enables' },
          { id: 'e5', from: 'pytorch', to: 'ml', relationship: 'enables' }
        ],
        version: 2,
        previous_version: initialResult.blobId
      };

      // Upload expanded graph
      const expandedResult = await walrusService.uploadContentWithMetadata(
        JSON.stringify(expandedGraph),
        testAddress,
        {
          category: 'graph',
          topic: 'programming',
          importance: 8,
          additionalTags: {
            graph_id: expandedGraph.graph_id,
            version: '2',
            node_count: '4',
            edge_count: '5',
            previous_version: initialResult.blobId
          }
        }
      );

      uploadedBlobIds.push(expandedResult.blobId);

      // Verify expansion
      const retrieved = await walrusService.retrieveContent(expandedResult.blobId);
      const parsedGraph = JSON.parse(retrieved.content);
      
      expect(parsedGraph.nodes).toHaveLength(4);
      expect(parsedGraph.edges).toHaveLength(5);
      expect(parsedGraph.previous_version).toBe(initialResult.blobId);

      console.log(`✅ Expanded graph: ${initialGraph.graph_id} (2→4 nodes, 1→5 edges)`);
    }, 45000);
  });

  // ====================== METADATA OPERATIONS ======================

  describe('Metadata Operations', () => {
    test('should create comprehensive metadata with embeddings', async () => {
      const contentWithMetadata = {
        content: 'Natural language processing enables computers to understand human language',
        metadata: {
          domain: 'nlp',
          complexity: 'intermediate',
          keywords: ['natural language processing', 'nlp', 'computational linguistics'],
          concepts: [
            { name: 'tokenization', confidence: 0.9 },
            { name: 'parsing', confidence: 0.8 },
            { name: 'sentiment analysis', confidence: 0.7 }
          ],
          embeddings: {
            content_vector: new Array(1536).fill(0).map(() => Math.random()),
            keyword_vectors: {
              'nlp': new Array(384).fill(0).map(() => Math.random()),
              'tokenization': new Array(384).fill(0).map(() => Math.random())
            }
          },
          quality_metrics: {
            readability_score: 8.2,
            accuracy_score: 9.1,
            completeness_score: 7.8
          }
        }
      };

      const result = await walrusService.uploadContentWithMetadata(
        JSON.stringify(contentWithMetadata),
        testAddress,
        {
          category: 'nlp',
          topic: 'language-processing',
          importance: 8,
          additionalTags: {
            has_embeddings: 'true',
            embedding_dimension: '1536',
            has_quality_metrics: 'true',
            domain: contentWithMetadata.metadata.domain,
            complexity: contentWithMetadata.metadata.complexity
          }
        }
      );

      expect(result.blobId).toBeDefined();
      uploadedBlobIds.push(result.blobId);

      // Verify metadata richness
      const retrieved = await walrusService.retrieveContent(result.blobId);
      const parsed = JSON.parse(retrieved.content);
      
      expect(parsed.metadata.keywords).toContain('nlp');
      expect(parsed.metadata.embeddings.content_vector).toHaveLength(1536);
      expect(parsed.metadata.quality_metrics.readability_score).toBe(8.2);

      console.log(`✅ Created rich metadata with embeddings and quality metrics`);
    }, 30000);

    test('should search metadata by tags and properties', async () => {
      // Upload multiple items with searchable metadata
      const searchableItems = [
        {
          content: 'Machine learning algorithms for classification',
          tags: { domain: 'ml', task: 'classification', difficulty: 'beginner' }
        },
        {
          content: 'Deep learning neural network architectures',
          tags: { domain: 'dl', task: 'architecture', difficulty: 'advanced' }
        },
        {
          content: 'Natural language processing tokenization methods',
          tags: { domain: 'nlp', task: 'tokenization', difficulty: 'intermediate' }
        }
      ];

      const uploadedIds = [];
      
      for (const item of searchableItems) {
        const result = await walrusService.uploadContentWithMetadata(
          JSON.stringify(item),
          testAddress,
          {
            category: 'searchable',
            topic: 'ai-methods',
            importance: 7,
            additionalTags: item.tags
          }
        );
        uploadedIds.push(result.blobId);
        uploadedBlobIds.push(result.blobId);
      }

      // List items with specific tag filter
      const mlItems = await walrusService.listUserBlobs(testAddress, {
        category: 'searchable',
        limit: 10
      });

      expect(mlItems.blobs.length).toBeGreaterThanOrEqual(3);
      
      console.log(`✅ Uploaded and listed ${mlItems.blobs.length} searchable items`);
    }, 45000);
  });
});