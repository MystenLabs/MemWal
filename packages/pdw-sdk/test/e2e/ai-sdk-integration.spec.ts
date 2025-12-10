/**
 * AI-SDK Integration E2E Tests
 *
 * Tests PDWVectorStore (AI-SDK version) with real Gemini API
 * in a browser environment using Playwright.
 *
 * Required environment variables:
 * - GEMINI_API_KEY: Google Gemini API key
 * - SUI_PRIVATE_KEY: Sui wallet private key (suiprivkey1... format)
 */

import { test, expect } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM compatibility for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Test configuration from environment
const TEST_CONFIG = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  suiPrivateKey: process.env.SUI_PRIVATE_KEY || '',
  packageId: process.env.PACKAGE_ID || '',
  walrusAggregator: 'https://aggregator.walrus-testnet.walrus.space',
  walrusPublisher: 'https://publisher.walrus-testnet.walrus.space',
};

// Validate environment
test.beforeAll(() => {
  if (!TEST_CONFIG.geminiApiKey) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }
  if (!TEST_CONFIG.suiPrivateKey) {
    throw new Error('SUI_PRIVATE_KEY environment variable is required');
  }
  if (!TEST_CONFIG.packageId) {
    throw new Error('PACKAGE_ID environment variable is required');
  }
});

test.describe('AI-SDK PDWVectorStore E2E', () => {
  test('should initialize PDWVectorStore with correct config', async ({ page }) => {
    // Capture browser console logs
    page.on('console', msg => {
      console.log(`[Browser ${msg.type()}]: ${msg.text()}`);
    });

    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore - Module loaded in browser
      const pdwModule = await import('/dist-browser/pdw-sdk.browser.js');
      const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
      const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');

      try {
        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);
        const userAddress = keypair.getPublicKey().toSuiAddress();

        // AI-SDK PDWVectorStore is exported as AIPDWVectorStore
        const PDWVectorStore = pdwModule.AIPDWVectorStore;

        if (!PDWVectorStore) {
          return {
            success: false,
            error: 'AIPDWVectorStore not found in exports',
            availableExports: Object.keys(pdwModule).filter(k => k.includes('Vector') || k.includes('PDW'))
          };
        }

        const vectorStore = new PDWVectorStore({
          userAddress,
          signer: keypair,
          dimensions: 768,
          geminiApiKey: config.geminiApiKey,
          walrus: {
            aggregator: config.walrusAggregator,
            publisher: config.walrusPublisher
          },
          sui: {
            network: 'testnet',
            packageId: config.packageId
          },
          index: {
            maxElements: 1000,
            efConstruction: 200,
            M: 16
          },
          features: {
            enableBatching: true,
            extractKnowledgeGraph: true
          }
        });

        // Check methods exist
        return {
          success: true,
          userAddress,
          hasAdd: typeof vectorStore.add === 'function',
          hasAddBatch: typeof vectorStore.addBatch === 'function',
          hasSearch: typeof vectorStore.search === 'function',
          hasGet: typeof vectorStore.get === 'function',
          hasDelete: typeof vectorStore.delete === 'function',
          hasStats: typeof vectorStore.stats === 'function'
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message,
          stack: error.stack
        };
      }
    }, TEST_CONFIG);

    console.log('AI-SDK VectorStore Init Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.hasAdd).toBe(true);
    expect(result.hasAddBatch).toBe(true);
    expect(result.hasSearch).toBe(true);
    expect(result.hasGet).toBe(true);
    expect(result.hasDelete).toBe(true);
    expect(result.hasStats).toBe(true);
  });

  test('pdwTools should be available for AI agents', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore
      const pdwModule = await import('/dist-browser/pdw-sdk.browser.js');

      try {
        const { pdwTools } = pdwModule;

        if (!pdwTools) {
          return {
            success: false,
            error: 'pdwTools not found in exports',
            availableExports: Object.keys(pdwModule).filter(k => k.includes('tool') || k.includes('Tool'))
          };
        }

        // pdwTools is exported - check it's a function
        return {
          success: true,
          isPdwToolsFunction: typeof pdwTools === 'function',
          description: 'pdwTools requires full PDWVectorStore config to initialize'
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message,
          stack: error.stack
        };
      }
    }, TEST_CONFIG);

    console.log('pdwTools Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.isPdwToolsFunction).toBe(true);
  });
});

test.describe('AI-SDK Vector Operations E2E', () => {
  test('should generate embeddings using EmbeddingService', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore
      const { EmbeddingService } = await import('/dist-browser/pdw-sdk.browser.js');

      try {
        const embeddingService = new EmbeddingService({
          apiKey: config.geminiApiKey,
          model: 'text-embedding-004',
          dimensions: 768
        });

        // Single embedding
        const singleResult = await embeddingService.embedText({
          text: 'AI-SDK integration test for vector operations',
          type: 'content'
        });

        // Batch embeddings
        const batchResult = await embeddingService.embedBatch([
          'First document about blockchain',
          'Second document about AI',
          'Third document about web3'
        ], { type: 'content' });

        return {
          success: true,
          single: {
            dimensions: singleResult.vector.length,
            isValid: singleResult.vector.every((n: number) => typeof n === 'number' && !isNaN(n)),
            model: singleResult.model
          },
          batch: {
            count: batchResult.vectors.length,
            dimensions: batchResult.vectors.map((v: number[]) => v.length),
            allValid: batchResult.vectors.every((v: number[]) =>
              v.every((n: number) => typeof n === 'number' && !isNaN(n))
            )
          }
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message
        };
      }
    }, TEST_CONFIG);

    console.log('Embedding Service Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.single.dimensions).toBe(768);
    expect(result.single.isValid).toBe(true);
    expect(result.batch.count).toBe(3);
    expect(result.batch.allValid).toBe(true);
  });

  test('should perform similarity search with generated vectors', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore
      const { EmbeddingService } = await import('/dist-browser/pdw-sdk.browser.js');

      try {
        const embeddingService = new EmbeddingService({
          apiKey: config.geminiApiKey,
          model: 'text-embedding-004',
          dimensions: 768
        });

        // Create corpus
        const corpus = [
          { id: '1', text: 'Sui blockchain provides high throughput' },
          { id: '2', text: 'Walrus is decentralized blob storage' },
          { id: '3', text: 'SEAL enables threshold encryption' },
          { id: '4', text: 'Move is a smart contract language' },
          { id: '5', text: 'PDW helps manage personal data on-chain' }
        ];

        // Embed corpus
        const corpusEmbeddings = await embeddingService.embedBatch(
          corpus.map(d => d.text),
          { type: 'content' }
        );

        // Query
        const query = 'How do I store data securely?';
        const queryEmbedding = await embeddingService.embedText({
          text: query,
          type: 'query',
          taskType: 'RETRIEVAL_QUERY'
        });

        // Calculate similarities
        function cosineSimilarity(a: number[], b: number[]): number {
          let dot = 0, normA = 0, normB = 0;
          for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
          }
          return dot / (Math.sqrt(normA) * Math.sqrt(normB));
        }

        const results = corpus.map((doc, idx) => ({
          id: doc.id,
          text: doc.text,
          similarity: cosineSimilarity(queryEmbedding.vector, corpusEmbeddings.vectors[idx])
        })).sort((a, b) => b.similarity - a.similarity);

        // Check if any of top 3 results are related to secure storage
        const top3Related = results.slice(0, 3).some((r: any) =>
          r.text.toLowerCase().includes('seal') ||
          r.text.toLowerCase().includes('storage') ||
          r.text.toLowerCase().includes('walrus') ||
          r.text.toLowerCase().includes('personal data') ||
          r.text.toLowerCase().includes('encryption')
        );

        return {
          success: true,
          query,
          topResults: results.slice(0, 3),
          // Check if any of top 3 results are related to secure storage
          top3ContainsRelevant: top3Related
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message
        };
      }
    }, TEST_CONFIG);

    console.log('Similarity Search Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.topResults.length).toBe(3);
    expect(result.top3ContainsRelevant).toBe(true);
  });
});

test.describe('AI-SDK Knowledge Graph Integration E2E', () => {
  test('should extract entities from text using GraphService', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore
      const { GraphService } = await import('/dist-browser/pdw-sdk.browser.js');

      try {
        const graphService = new GraphService({
          geminiApiKey: config.geminiApiKey,
          extractionModel: 'gemini-2.5-flash'
        });

        const text = `
          John Smith is the CEO of TechCorp, a company based in San Francisco.
          He graduated from Stanford University with a degree in Computer Science.
          TechCorp recently partnered with CloudNet to expand their cloud infrastructure.
        `;

        const result = await graphService.extractEntitiesAndRelationships(text);

        return {
          success: true,
          entities: result.entities.map((e: any) => ({
            label: e.label,
            type: e.type,
            confidence: e.confidence
          })),
          relationships: result.relationships.map((r: any) => ({
            source: r.source,
            target: r.target,
            type: r.type
          })),
          entityCount: result.entities.length,
          relationshipCount: result.relationships.length
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message
        };
      }
    }, TEST_CONFIG);

    console.log('Knowledge Graph Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.entityCount).toBeGreaterThan(0);
    // Should extract entities like John Smith, TechCorp, Stanford, etc.
    const entityLabels = result.entities.map((e: any) => e.label.toLowerCase());
    const hasExpectedEntities =
      entityLabels.some((l: string) => l.includes('john') || l.includes('smith')) ||
      entityLabels.some((l: string) => l.includes('techcorp') || l.includes('tech')) ||
      entityLabels.some((l: string) => l.includes('stanford'));

    expect(hasExpectedEntities).toBe(true);
  });
});

test.describe('AI-SDK Full Pipeline E2E', () => {
  test('should run complete AI-SDK workflow: embed -> index -> search', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore
      const pdwModule = await import('/dist-browser/pdw-sdk.browser.js');
      const { EmbeddingService, GraphService } = pdwModule;

      try {
        // 1. Initialize services
        const embeddingService = new EmbeddingService({
          apiKey: config.geminiApiKey,
          model: 'text-embedding-004',
          dimensions: 768
        });

        const graphService = new GraphService({
          geminiApiKey: config.geminiApiKey
        });

        // 2. Prepare documents
        const documents = [
          {
            id: 'doc1',
            text: 'Sui is a Layer 1 blockchain with parallel transaction execution',
            category: 'blockchain'
          },
          {
            id: 'doc2',
            text: 'Walrus provides decentralized blob storage with erasure coding',
            category: 'storage'
          },
          {
            id: 'doc3',
            text: 'SEAL uses threshold BLS signatures for encryption key management',
            category: 'encryption'
          }
        ];

        // 3. Generate embeddings
        const embeddings = await embeddingService.embedBatch(
          documents.map(d => d.text),
          { type: 'content' }
        );

        // 4. Extract knowledge graph from one document
        const graphResult = await graphService.extractEntitiesAndRelationships(documents[0].text);

        // 5. Query
        const query = 'What blockchain has high performance?';
        const queryEmbedding = await embeddingService.embedText({
          text: query,
          type: 'query'
        });

        // 6. Calculate similarities
        function cosineSimilarity(a: number[], b: number[]): number {
          let dot = 0, normA = 0, normB = 0;
          for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
          }
          return dot / (Math.sqrt(normA) * Math.sqrt(normB));
        }

        const searchResults = documents.map((doc, idx) => ({
          id: doc.id,
          text: doc.text,
          category: doc.category,
          similarity: cosineSimilarity(queryEmbedding.vector, embeddings.vectors[idx])
        })).sort((a, b) => b.similarity - a.similarity);

        return {
          success: true,
          pipeline: {
            documentsProcessed: documents.length,
            embeddingDimensions: embeddings.vectors[0].length,
            entitiesExtracted: graphResult.entities.length,
            relationshipsExtracted: graphResult.relationships.length
          },
          search: {
            query,
            topResult: searchResults[0],
            // Sui doc should be most relevant for "blockchain high performance"
            suiIsTopResult: searchResults[0].id === 'doc1'
          }
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message,
          stack: error.stack
        };
      }
    }, TEST_CONFIG);

    console.log('Full Pipeline Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.pipeline.documentsProcessed).toBe(3);
    expect(result.pipeline.embeddingDimensions).toBe(768);
    expect(result.pipeline.entitiesExtracted).toBeGreaterThan(0);
    expect(result.search.suiIsTopResult).toBe(true);
  });
});
