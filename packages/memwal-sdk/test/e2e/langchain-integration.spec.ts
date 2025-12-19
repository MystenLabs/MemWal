/**
 * LangChain Integration E2E Tests
 *
 * Tests PDWEmbeddings and PDWVectorStore with real Gemini API
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

test.describe('LangChain Integration E2E', () => {
  test('PDWEmbeddings should generate embeddings with real Gemini API', async ({ page }) => {
    // Capture browser console logs
    page.on('console', msg => {
      console.log(`[Browser ${msg.type()}]: ${msg.text()}`);
    });

    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore - Module loaded in browser
      const { PDWEmbeddings } = await import('/dist-browser/pdw-sdk.browser.js');

      try {
        // Create PDWEmbeddings instance
        const embeddings = new PDWEmbeddings({
          geminiApiKey: config.geminiApiKey,
          model: 'text-embedding-004',
          dimensions: 768
        });

        // Test model info
        const modelInfo = embeddings.getModelInfo();

        // Test embedQuery - single query embedding
        const queryVector = await embeddings.embedQuery('What is TypeScript?');

        // Test embedDocuments - batch document embeddings
        const documents = [
          'TypeScript is a strongly typed programming language',
          'JavaScript is a dynamic scripting language',
          'React is a UI library for building web applications'
        ];
        const docVectors = await embeddings.embedDocuments(documents);

        return {
          success: true,
          modelInfo,
          query: {
            text: 'What is TypeScript?',
            dimensions: queryVector.length,
            isValid: queryVector.every((n: number) => typeof n === 'number' && !isNaN(n)),
            sampleValues: queryVector.slice(0, 5)
          },
          documents: {
            count: docVectors.length,
            dimensions: docVectors.map((v: number[]) => v.length),
            allValid: docVectors.every((v: number[]) =>
              v.every((n: number) => typeof n === 'number' && !isNaN(n))
            )
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

    console.log('PDWEmbeddings Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.modelInfo.model).toBe('text-embedding-004');
    expect(result.modelInfo.dimensions).toBe(768);
    expect(result.modelInfo.provider).toBe('Google Gemini');

    // Query embedding tests
    expect(result.query.dimensions).toBe(768);
    expect(result.query.isValid).toBe(true);

    // Document embeddings tests
    expect(result.documents.count).toBe(3);
    expect(result.documents.dimensions).toEqual([768, 768, 768]);
    expect(result.documents.allValid).toBe(true);
  });

  test('PDWEmbeddings similarity calculation should work', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore
      const { PDWEmbeddings } = await import('/dist-browser/pdw-sdk.browser.js');

      try {
        const embeddings = new PDWEmbeddings({
          geminiApiKey: config.geminiApiKey
        });

        // Embed similar and dissimilar texts
        const texts = [
          'I love programming in TypeScript',
          'TypeScript is my favorite programming language',
          'The weather is sunny today',
          'I enjoy cooking Italian food'
        ];

        const vectors = await embeddings.embedDocuments(texts);

        // Calculate cosine similarity
        function cosineSimilarity(a: number[], b: number[]): number {
          let dotProduct = 0;
          let normA = 0;
          let normB = 0;
          for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
          }
          return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
        }

        // Similar texts should have higher similarity
        const sim01 = cosineSimilarity(vectors[0], vectors[1]); // TypeScript texts
        const sim02 = cosineSimilarity(vectors[0], vectors[2]); // TypeScript vs weather
        const sim03 = cosineSimilarity(vectors[0], vectors[3]); // TypeScript vs cooking

        return {
          success: true,
          similarities: {
            typescript_to_typescript: sim01,
            typescript_to_weather: sim02,
            typescript_to_cooking: sim03
          },
          similar_texts_have_higher_score: sim01 > sim02 && sim01 > sim03
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message
        };
      }
    }, TEST_CONFIG);

    console.log('Similarity Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.similar_texts_have_higher_score).toBe(true);
    expect(result.similarities.typescript_to_typescript).toBeGreaterThan(0.7);
  });

  test('PDWVectorStore should initialize correctly', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore
      const { PDWEmbeddings, PDWVectorStore } = await import('/dist-browser/pdw-sdk.browser.js');
      const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
      const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');

      try {
        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);
        const userAddress = keypair.getPublicKey().toSuiAddress();

        const embeddings = new PDWEmbeddings({
          geminiApiKey: config.geminiApiKey
        });

        const vectorStore = new PDWVectorStore(embeddings, {
          userAddress,
          packageId: config.packageId,
          walrusAggregator: config.walrusAggregator,
          geminiApiKey: config.geminiApiKey,
          network: 'testnet'
        });

        return {
          success: true,
          type: vectorStore._vectorstoreType(),
          hasAddDocuments: typeof vectorStore.addDocuments === 'function',
          hasSimilaritySearch: typeof vectorStore.similaritySearch === 'function',
          hasAsRetriever: typeof vectorStore.asRetriever === 'function',
          hasDelete: typeof vectorStore.delete === 'function',
          hasGetStats: typeof vectorStore.getStats === 'function',
          userAddress
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message,
          stack: error.stack
        };
      }
    }, TEST_CONFIG);

    console.log('PDWVectorStore Init Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.type).toBe('pdw');
    expect(result.hasAddDocuments).toBe(true);
    expect(result.hasSimilaritySearch).toBe(true);
    expect(result.hasAsRetriever).toBe(true);
    expect(result.hasDelete).toBe(true);
    expect(result.hasGetStats).toBe(true);
  });

  test('PDWVectorStore should create retriever for RAG workflows', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore
      const { PDWEmbeddings, PDWVectorStore } = await import('/dist-browser/pdw-sdk.browser.js');
      const { Ed25519Keypair } = await import('https://esm.sh/@mysten/sui@1.44.0/keypairs/ed25519');
      const { decodeSuiPrivateKey } = await import('https://esm.sh/@mysten/sui@1.44.0/cryptography');

      try {
        const { secretKey } = decodeSuiPrivateKey(config.suiPrivateKey);
        const keypair = Ed25519Keypair.fromSecretKey(secretKey);
        const userAddress = keypair.getPublicKey().toSuiAddress();

        const embeddings = new PDWEmbeddings({
          geminiApiKey: config.geminiApiKey
        });

        const vectorStore = new PDWVectorStore(embeddings, {
          userAddress,
          packageId: config.packageId,
          walrusAggregator: config.walrusAggregator,
          geminiApiKey: config.geminiApiKey
        });

        // Create retriever for RAG
        const retriever = vectorStore.asRetriever({
          k: 5,
          filter: { category: 'general' }
        });

        return {
          success: true,
          hasRetriever: !!retriever,
          retrieverType: retriever?.constructor?.name || 'unknown',
          hasInvoke: typeof retriever?.invoke === 'function',
          hasGetRelevantDocuments: typeof retriever?.getRelevantDocuments === 'function'
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message
        };
      }
    }, TEST_CONFIG);

    console.log('Retriever Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.hasRetriever).toBe(true);
  });
});

test.describe('LangChain RAG Workflow E2E', () => {
  test('should support basic RAG pattern with embeddings', async ({ page }) => {
    await page.goto('/test-page.html');

    const result = await page.evaluate(async (config) => {
      // @ts-ignore
      const { PDWEmbeddings } = await import('/dist-browser/pdw-sdk.browser.js');

      try {
        const embeddings = new PDWEmbeddings({
          geminiApiKey: config.geminiApiKey
        });

        // Simulate RAG workflow
        // 1. Index documents (create embeddings)
        const documents = [
          { content: 'Sui is a Layer 1 blockchain with high throughput', id: 'doc1' },
          { content: 'Walrus is a decentralized storage protocol on Sui', id: 'doc2' },
          { content: 'SEAL provides threshold encryption for privacy', id: 'doc3' },
          { content: 'Move is the smart contract language for Sui', id: 'doc4' },
          { content: 'PDW SDK helps build personal data wallets', id: 'doc5' }
        ];

        const docVectors = await embeddings.embedDocuments(
          documents.map(d => d.content)
        );

        // 2. Query embedding
        const query = 'How does decentralized storage work?';
        const queryVector = await embeddings.embedQuery(query);

        // 3. Calculate similarities (simulating vector search)
        function cosineSimilarity(a: number[], b: number[]): number {
          let dot = 0, normA = 0, normB = 0;
          for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
          }
          return dot / (Math.sqrt(normA) * Math.sqrt(normB));
        }

        const similarities = docVectors.map((vec: number[], idx: number) => ({
          id: documents[idx].id,
          content: documents[idx].content,
          similarity: cosineSimilarity(queryVector, vec)
        }));

        // Sort by similarity descending
        similarities.sort((a: any, b: any) => b.similarity - a.similarity);

        // Top 3 results
        const topResults = similarities.slice(0, 3);

        return {
          success: true,
          query,
          topResults,
          mostRelevant: topResults[0].id,
          // Walrus doc should be most relevant for storage query
          walrusIsTopResult: topResults[0].id === 'doc2'
        };
      } catch (error: any) {
        return {
          success: false,
          error: error.message
        };
      }
    }, TEST_CONFIG);

    console.log('RAG Workflow Result:', JSON.stringify(result, null, 2));

    expect(result.success).toBe(true);
    expect(result.topResults.length).toBe(3);
    // Walrus document should be most relevant for "decentralized storage" query
    expect(result.walrusIsTopResult).toBe(true);
  });
});
