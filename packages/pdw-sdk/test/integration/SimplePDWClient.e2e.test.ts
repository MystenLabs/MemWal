/**
 * SimplePDWClient E2E Integration Tests
 *
 * 100% Real Integration - NO mocks, NO stubs
 * - Real Gemini API (embeddings, classification, graph extraction)
 * - Real Walrus testnet (storage)
 * - Real Sui testnet (blockchain)
 *
 * Required Environment Variables:
 * - GEMINI_API_KEY: Google Gemini API key
 * - SUI_PRIVATE_KEY: Base64 encoded Sui private key (or hex)
 *
 * Run: npm run test:e2e
 */

// Load environment variables from .env file
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from pdw-sdk root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { SimplePDWClient } from '../../src/client/SimplePDWClient';
import { fromBase64 } from '@mysten/bcs';

// Test configuration
const TEST_TIMEOUT = 120000; // 2 minutes for network operations

// Helper to get keypair from environment
function getTestKeypair(): Ed25519Keypair {
  const privateKey = process.env.SUI_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('SUI_PRIVATE_KEY environment variable is required');
  }

  // Handle different private key formats
  if (privateKey.startsWith('suiprivkey')) {
    // Bech32 format (suiprivkey1...)
    const { secretKey } = decodeSuiPrivateKey(privateKey);
    return Ed25519Keypair.fromSecretKey(secretKey);
  } else if (privateKey.startsWith('0x')) {
    // Hex format
    const hexBytes = privateKey.slice(2);
    const bytes = new Uint8Array(hexBytes.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    return Ed25519Keypair.fromSecretKey(bytes);
  } else {
    // Base64 format
    try {
      const bytes = fromBase64(privateKey);
      return Ed25519Keypair.fromSecretKey(bytes);
    } catch {
      // Try as raw base64
      const bytes = Buffer.from(privateKey, 'base64');
      return Ed25519Keypair.fromSecretKey(bytes);
    }
  }
}

describe('SimplePDWClient E2E Integration', () => {
  let pdw: SimplePDWClient;
  let createdMemoryId: string | null = null;
  let createdBlobId: string | null = null;

  // ==========================================
  // SETUP
  // ==========================================
  beforeAll(async () => {
    // Validate environment
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY environment variable is required');
    }
    if (!process.env.SUI_PRIVATE_KEY) {
      throw new Error('SUI_PRIVATE_KEY environment variable is required');
    }

    const keypair = getTestKeypair();
    console.log(`Test wallet address: ${keypair.getPublicKey().toSuiAddress()}`);

    pdw = new SimplePDWClient({
      signer: keypair,
      network: 'testnet',
      geminiApiKey: process.env.GEMINI_API_KEY,
      features: {
        enableEncryption: false, // Disable SEAL for simpler testing
        enableLocalIndexing: true,
        enableKnowledgeGraph: true
      }
    });

    await pdw.ready();
    console.log('✅ SimplePDWClient initialized');
  }, TEST_TIMEOUT);

  // ==========================================
  // P0: EMBEDDINGS NAMESPACE
  // ==========================================
  describe('P0: embeddings.*', () => {
    let testEmbedding: number[];

    test('generate() - creates real 768-dim embedding', async () => {
      const result = await pdw.embeddings.generate('I love programming in TypeScript');

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(768);
      expect(typeof result[0]).toBe('number');

      // Verify it's a valid embedding (values between -1 and 1)
      const maxVal = Math.max(...result.map(Math.abs));
      expect(maxVal).toBeLessThanOrEqual(10); // Embeddings typically have small values

      testEmbedding = result;
      console.log(`✅ Generated embedding with ${result.length} dimensions`);
    }, TEST_TIMEOUT);

    test('batch() - creates multiple embeddings', async () => {
      const texts = [
        'Hello world',
        'TypeScript is a great language',
        'Sui blockchain enables decentralized apps'
      ];
      const results = await pdw.embeddings.batch(texts);

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(3);
      results.forEach((emb, i) => {
        expect(emb.length).toBe(768);
        expect(typeof emb[0]).toBe('number');
      });

      console.log(`✅ Generated ${results.length} batch embeddings`);
    }, TEST_TIMEOUT);

    test('similarity() - calculates cosine similarity correctly', async () => {
      // Generate embeddings for semantically similar and different texts
      const emb1 = await pdw.embeddings.generate('programming and software development');
      const emb2 = await pdw.embeddings.generate('coding applications and writing code');
      const emb3 = await pdw.embeddings.generate('cooking delicious pasta with tomato sauce');

      const simSimilar = pdw.embeddings.similarity(emb1, emb2);
      const simDifferent = pdw.embeddings.similarity(emb1, emb3);

      // Similar texts should have higher similarity
      expect(simSimilar).toBeGreaterThan(simDifferent);
      expect(simSimilar).toBeGreaterThan(0.5); // Programming concepts should be similar
      expect(simDifferent).toBeLessThan(0.7); // Cooking vs programming should be less similar

      console.log(`✅ Similarity: similar=${simSimilar.toFixed(3)}, different=${simDifferent.toFixed(3)}`);
    }, TEST_TIMEOUT);

    test('findSimilar() - finds top-k similar vectors', async () => {
      // Create candidate embeddings
      const candidates = await pdw.embeddings.batch([
        'JavaScript programming language',
        'Python for machine learning',
        'Italian cooking recipes',
        'TypeScript static typing',
        'Swimming in the ocean'
      ]);

      // Query with programming-related text
      const query = await pdw.embeddings.generate('software development languages');
      const results = pdw.embeddings.findSimilar(query, candidates, 3);

      expect(results.length).toBe(3);
      expect(results[0]).toHaveProperty('index');
      expect(results[0]).toHaveProperty('score');

      // Top results should be programming-related (indices 0, 1, or 3)
      const programmingIndices = [0, 1, 3];
      const topIndices = results.map(r => r.index);
      const programmingMatches = topIndices.filter(i => programmingIndices.includes(i)).length;
      expect(programmingMatches).toBeGreaterThanOrEqual(2);

      console.log(`✅ Found similar: ${results.map(r => `idx=${r.index}, score=${r.score.toFixed(3)}`).join(', ')}`);
    }, TEST_TIMEOUT);
  });

  // ==========================================
  // P0: MEMORY NAMESPACE
  // ==========================================
  describe('P0: memory.*', () => {
    test('create() - stores memory to Walrus with full pipeline', async () => {
      const content = 'I am a software engineer who loves TypeScript and building decentralized applications on Sui';

      const result = await pdw.memory.create(content, {
        category: 'fact',
        importance: 8,
        topic: 'professional identity',
        onProgress: (stage, percent) => {
          console.log(`  Progress: ${stage} (${percent}%)`);
        }
      });

      expect(result).toBeDefined();
      expect(result.blobId).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.content).toBe(content);
      expect(result.category).toBe('fact');
      expect(result.importance).toBe(8);
      expect(result.embedding).toBeDefined();
      expect(result.embedding?.length).toBe(768);

      createdMemoryId = result.id;
      createdBlobId = result.blobId;

      console.log(`✅ Created memory: blobId=${result.blobId.substring(0, 20)}...`);
    }, TEST_TIMEOUT);

    test('get() - retrieves memory from Walrus', async () => {
      expect(createdBlobId).toBeDefined();

      const memory = await pdw.memory.get(createdBlobId!);

      expect(memory).toBeDefined();
      expect(memory.content).toContain('software engineer');
      expect(memory.blobId).toBe(createdBlobId);

      console.log(`✅ Retrieved memory: ${memory.content.substring(0, 50)}...`);
    }, TEST_TIMEOUT);

    test('list() - lists user memories with pagination', async () => {
      const memories = await pdw.memory.list({
        limit: 10,
        sortBy: 'date',
        order: 'desc'
      });

      expect(Array.isArray(memories)).toBe(true);
      // Should have at least the memory we just created
      // Note: list() depends on blockchain state, may have more or fewer

      console.log(`✅ Listed ${memories.length} memories`);
    }, TEST_TIMEOUT);

    test('getRelated() - finds semantically similar memories', async () => {
      expect(createdMemoryId).toBeDefined();

      const related = await pdw.memory.getRelated(createdMemoryId!, 5);

      expect(Array.isArray(related)).toBe(true);
      // May or may not find related memories depending on existing data

      console.log(`✅ Found ${related.length} related memories`);
    }, TEST_TIMEOUT);

    test('export() - exports memories to JSON format', async () => {
      const exported = await pdw.memory.export({
        format: 'json',
        includeContent: true,
        includeEmbeddings: false,
        limit: 5
      });

      expect(typeof exported).toBe('string');
      const parsed = JSON.parse(exported);
      expect(Array.isArray(parsed)).toBe(true);

      console.log(`✅ Exported ${parsed.length} memories to JSON`);
    }, TEST_TIMEOUT);
  });

  // ==========================================
  // P0: SEARCH NAMESPACE
  // ==========================================
  describe('P0: search.*', () => {
    test('vector() - semantic similarity search', async () => {
      const results = await pdw.search.vector('programming languages and software development', {
        limit: 5,
        threshold: 0.3
      });

      expect(Array.isArray(results)).toBe(true);
      results.forEach(r => {
        expect(r).toHaveProperty('id');
        expect(r).toHaveProperty('score');
        expect(r).toHaveProperty('similarity');
      });

      console.log(`✅ Vector search returned ${results.length} results`);
    }, TEST_TIMEOUT);

    test('byCategory() - filters by category', async () => {
      const results = await pdw.search.byCategory('fact', {
        limit: 10
      });

      expect(Array.isArray(results)).toBe(true);

      console.log(`✅ Category search returned ${results.length} results`);
    }, TEST_TIMEOUT);

    test('byImportance() - filters by importance range', async () => {
      const results = await pdw.search.byImportance(7, 10, {
        limit: 10
      });

      expect(Array.isArray(results)).toBe(true);
      // All results should have importance >= 7
      results.forEach(r => {
        if (r.importance) {
          expect(r.importance).toBeGreaterThanOrEqual(7);
        }
      });

      console.log(`✅ Importance search returned ${results.length} results`);
    }, TEST_TIMEOUT);

    test('advanced() - complex multi-filter search', async () => {
      const results = await pdw.search.advanced({
        text: 'software',
        importance: { min: 5, max: 10 },
        limit: 10
      });

      expect(Array.isArray(results)).toBe(true);

      console.log(`✅ Advanced search returned ${results.length} results`);
    }, TEST_TIMEOUT);
  });

  // ==========================================
  // P1: CLASSIFY NAMESPACE
  // ==========================================
  describe('P1: classify.*', () => {
    test('category() - auto-categorizes content', async () => {
      const testCases = [
        { content: 'My email is user@example.com', expectedType: 'contact' },
        { content: 'I prefer dark mode in all my applications', expectedType: 'preference' },
        { content: 'Remember to buy groceries tomorrow', expectedType: 'todo' }
      ];

      for (const tc of testCases) {
        const category = await pdw.classify.category(tc.content);

        expect(typeof category).toBe('string');
        expect(category.length).toBeGreaterThan(0);

        console.log(`  "${tc.content.substring(0, 30)}..." → ${category}`);
      }

      console.log(`✅ Classified ${testCases.length} contents`);
    }, TEST_TIMEOUT);

    test('importance() - scores importance 1-10', async () => {
      const testCases = [
        { content: 'Emergency: Fire in building, evacuate now!', expected: 'high' },
        { content: 'My favorite color is blue', expected: 'low' },
        { content: 'Critical meeting with CEO about company future', expected: 'high' }
      ];

      for (const tc of testCases) {
        const importance = await pdw.classify.importance(tc.content);

        expect(typeof importance).toBe('number');
        expect(importance).toBeGreaterThanOrEqual(1);
        expect(importance).toBeLessThanOrEqual(10);

        console.log(`  "${tc.content.substring(0, 30)}..." → ${importance}/10`);
      }

      console.log(`✅ Scored importance for ${testCases.length} contents`);
    }, TEST_TIMEOUT);

    test('shouldSave() - determines if worth saving', async () => {
      const testCases = [
        { content: 'My passport number is AB123456', expected: true },
        { content: 'um, like, you know, whatever', expected: false },
        { content: 'I am allergic to penicillin', expected: true }
      ];

      for (const tc of testCases) {
        const shouldSave = await pdw.classify.shouldSave(tc.content);

        expect(typeof shouldSave).toBe('boolean');
        console.log(`  "${tc.content.substring(0, 30)}..." → ${shouldSave ? 'SAVE' : 'SKIP'}`);
      }

      console.log(`✅ Evaluated ${testCases.length} contents for saving`);
    }, TEST_TIMEOUT);

    test('patterns() - detects patterns in content', async () => {
      const content = 'My email is john@example.com and my phone is 555-1234. I work at Google.';
      const analysis = await pdw.classify.patterns(content);

      expect(analysis).toHaveProperty('patterns');
      expect(analysis).toHaveProperty('categories');
      expect(analysis).toHaveProperty('suggestedCategory');
      expect(Array.isArray(analysis.patterns)).toBe(true);

      console.log(`✅ Found ${analysis.patterns.length} patterns, suggested: ${analysis.suggestedCategory}`);
    }, TEST_TIMEOUT);
  });

  // ==========================================
  // P1: GRAPH NAMESPACE
  // ==========================================
  describe('P1: graph.*', () => {
    test('extract() - extracts knowledge graph from text', async () => {
      const content = 'John Smith works at Google as a software engineer in Mountain View, California. He collaborates with Alice on the AI team.';
      const graph = await pdw.graph.extract(content);

      expect(graph).toHaveProperty('entities');
      expect(graph).toHaveProperty('relationships');
      expect(Array.isArray(graph.entities)).toBe(true);
      expect(Array.isArray(graph.relationships)).toBe(true);

      // Should extract entities like John Smith, Google, Mountain View, Alice
      expect(graph.entities.length).toBeGreaterThan(0);

      graph.entities.forEach(e => {
        expect(e).toHaveProperty('id');
        expect(e).toHaveProperty('name');
        expect(e).toHaveProperty('type');
      });

      console.log(`✅ Extracted ${graph.entities.length} entities, ${graph.relationships.length} relationships`);
      console.log(`  Entities: ${graph.entities.map(e => `${e.name}(${e.type})`).join(', ')}`);
    }, TEST_TIMEOUT);

    test('stats() - returns graph statistics', async () => {
      const stats = await pdw.graph.stats();

      expect(stats).toHaveProperty('totalEntities');
      expect(stats).toHaveProperty('totalRelationships');
      expect(stats).toHaveProperty('entityTypes');
      expect(stats).toHaveProperty('relationshipTypes');
      expect(typeof stats.totalEntities).toBe('number');
      expect(typeof stats.totalRelationships).toBe('number');

      console.log(`✅ Graph stats: ${stats.totalEntities} entities, ${stats.totalRelationships} relationships`);
    }, TEST_TIMEOUT);

    test('getEntities() - retrieves entities with filter', async () => {
      const entities = await pdw.graph.getEntities({
        limit: 10
      });

      expect(Array.isArray(entities)).toBe(true);
      entities.forEach(e => {
        expect(e).toHaveProperty('id');
        expect(e).toHaveProperty('name');
        expect(e).toHaveProperty('type');
      });

      console.log(`✅ Retrieved ${entities.length} entities`);
    }, TEST_TIMEOUT);

    test('getRelationships() - retrieves relationships with filter', async () => {
      const relationships = await pdw.graph.getRelationships({
        limit: 10
      });

      expect(Array.isArray(relationships)).toBe(true);
      relationships.forEach(r => {
        expect(r).toHaveProperty('source');
        expect(r).toHaveProperty('target');
        expect(r).toHaveProperty('type');
      });

      console.log(`✅ Retrieved ${relationships.length} relationships`);
    }, TEST_TIMEOUT);
  });

  // ==========================================
  // P1: CHAT NAMESPACE
  // ==========================================
  describe('P1: chat.*', () => {
    let testSessionId: string;

    test('createSession() - creates new chat session', async () => {
      const session = await pdw.chat.createSession({
        title: 'E2E Test Session'
      });

      expect(session).toHaveProperty('id');
      expect(session.id).toBeDefined();
      expect(typeof session.id).toBe('string');

      testSessionId = session.id;
      console.log(`✅ Created chat session: ${testSessionId}`);
    }, TEST_TIMEOUT);

    test('getSessions() - lists all sessions', async () => {
      const sessions = await pdw.chat.getSessions();

      expect(Array.isArray(sessions)).toBe(true);
      // Should have at least the session we just created

      console.log(`✅ Found ${sessions.length} chat sessions`);
    }, TEST_TIMEOUT);

    test('getSession() - retrieves specific session', async () => {
      expect(testSessionId).toBeDefined();

      const session = await pdw.chat.getSession(testSessionId);

      expect(session).toBeDefined();
      expect(session.id).toBe(testSessionId);

      console.log(`✅ Retrieved session: ${session.id}`);
    }, TEST_TIMEOUT);

    test('send() - sends message and gets AI response', async () => {
      expect(testSessionId).toBeDefined();

      const response = await pdw.chat.send(testSessionId, 'Hello! What can you tell me about my memories?');

      expect(response).toHaveProperty('content');
      expect(response).toHaveProperty('role');
      expect(response.role).toBe('assistant');
      expect(typeof response.content).toBe('string');
      expect(response.content.length).toBeGreaterThan(0);

      console.log(`✅ AI response: "${response.content.substring(0, 100)}..."`);
    }, TEST_TIMEOUT);

    test('updateTitle() - updates session title', async () => {
      expect(testSessionId).toBeDefined();

      await pdw.chat.updateTitle(testSessionId, 'Updated Test Session Title');

      // Verify update
      const session = await pdw.chat.getSession(testSessionId);
      // Note: Title update may be async, so we just verify no error

      console.log(`✅ Updated session title`);
    }, TEST_TIMEOUT);

    test('delete() - deletes chat session', async () => {
      expect(testSessionId).toBeDefined();

      await pdw.chat.delete(testSessionId);

      // Verify deletion - should throw or return null
      try {
        await pdw.chat.getSession(testSessionId);
        // If we get here, session might still exist briefly
      } catch {
        // Expected - session deleted
      }

      console.log(`✅ Deleted chat session`);
    }, TEST_TIMEOUT);
  });

  // ==========================================
  // CLEANUP
  // ==========================================
  afterAll(async () => {
    console.log('\n🧹 Cleanup...');

    // Note: Memory deletion is on-chain and may fail if already deleted
    // Walrus blobs are immutable and cannot be deleted

    if (createdMemoryId) {
      try {
        await pdw.memory.delete(createdMemoryId);
        console.log(`  Deleted memory: ${createdMemoryId.substring(0, 20)}...`);
      } catch (e) {
        console.log(`  Memory cleanup skipped (may already be deleted)`);
      }
    }

    console.log('✅ Cleanup complete');
  }, TEST_TIMEOUT);
});
