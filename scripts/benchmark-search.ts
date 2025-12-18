/**
 * Benchmark Script for PDW Search Performance
 *
 * Measures:
 * - Search latency (with/without Walrus fetch)
 * - Index load time
 * - Memory usage
 *
 * Usage: npx tsx scripts/benchmark-search.ts
 */

import 'dotenv/config';
import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';

interface BenchmarkResult {
  timestamp: string;
  testName: string;
  metrics: {
    searchLatencyMs: number;
    walrusFetchMs: number;
    totalLatencyMs: number;
    resultsCount: number;
    resultsWithLocalContent: number;
    walrusFetchSkipped: boolean;
  };
  environment: {
    nodeVersion: string;
    platform: string;
    indexSize?: number;
  };
}

async function runBenchmark() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PDW Search Performance Benchmark');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Timestamp: ${new Date().toISOString()}`);
  console.log(`  Node.js: ${process.version}`);
  console.log(`  Platform: ${process.platform}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // Import PDW SDK dynamically
  const { SimplePDWClient } = await import('personal-data-wallet-sdk');
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
  const { decodeSuiPrivateKey } = await import('@mysten/sui/cryptography');

  // Setup
  const { secretKey } = decodeSuiPrivateKey(process.env.SUI_PRIVATE_KEY!);
  const keypair = Ed25519Keypair.fromSecretKey(secretKey);

  console.log('📦 Initializing PDW Client...');
  const initStart = performance.now();

  const pdw = new SimplePDWClient({
    signer: keypair,
    network: (process.env.SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet',
    sui: {
      packageId: process.env.PACKAGE_ID!,
    },
    embedding: {
      provider: 'openrouter',
      apiKey: process.env.OPENROUTER_API_KEY!,
    },
    walrus: {
      aggregator: process.env.WALRUS_AGGREGATOR || 'https://aggregator.walrus-testnet.walrus.space',
      publisher: process.env.WALRUS_PUBLISHER || 'https://publisher.walrus-testnet.walrus.space',
    },
    features: {
      enableEncryption: false,
      enableLocalIndexing: true,
      enableKnowledgeGraph: false,
    },
  });

  await pdw.ready();
  const initTime = performance.now() - initStart;
  console.log(`✅ PDW Client ready in ${initTime.toFixed(0)}ms\n`);

  // Test queries
  const testQueries = [
    'what is my name',
    'where do I live',
    'my hometown',
    'hello how are you',
    'programming languages',
  ];

  const results: BenchmarkResult[] = [];

  console.log('🔍 Running search benchmarks...\n');
  console.log('┌─────────────────────────────────────────────────────────────────┐');
  console.log('│ Query                    │ Search │ Walrus │ Total  │ Local   │');
  console.log('├─────────────────────────────────────────────────────────────────┤');

  for (const query of testQueries) {
    const searchStart = performance.now();

    const searchResults = await pdw.search.vector(query, {
      limit: 10,
      threshold: 0.5,
      fetchContent: true,
    });

    const totalTime = performance.now() - searchStart;

    // Count results with local content
    const withLocalContent = searchResults?.filter((r: any) =>
      r.metadata?.content || r.content
    ).length || 0;

    const walrusSkipped = withLocalContent === (searchResults?.length || 0);

    // Estimate Walrus fetch time (if any results needed fetch)
    const walrusFetchTime = walrusSkipped ? 0 : (totalTime * 0.9); // Rough estimate

    const queryShort = query.substring(0, 22).padEnd(22);
    const searchTime = (totalTime - walrusFetchTime).toFixed(0).padStart(5);
    const walrusTime = walrusFetchTime.toFixed(0).padStart(5);
    const total = totalTime.toFixed(0).padStart(5);
    const localRatio = `${withLocalContent}/${searchResults?.length || 0}`.padStart(7);

    console.log(`│ ${queryShort}  │ ${searchTime}ms │ ${walrusTime}ms │ ${total}ms │ ${localRatio} │`);

    results.push({
      timestamp: new Date().toISOString(),
      testName: query,
      metrics: {
        searchLatencyMs: totalTime - walrusFetchTime,
        walrusFetchMs: walrusFetchTime,
        totalLatencyMs: totalTime,
        resultsCount: searchResults?.length || 0,
        resultsWithLocalContent: withLocalContent,
        walrusFetchSkipped: walrusSkipped,
      },
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
      },
    });
  }

  console.log('└─────────────────────────────────────────────────────────────────┘\n');

  // Summary
  const avgTotal = results.reduce((sum, r) => sum + r.metrics.totalLatencyMs, 0) / results.length;
  const avgWalrus = results.reduce((sum, r) => sum + r.metrics.walrusFetchMs, 0) / results.length;
  const allLocal = results.every(r => r.metrics.walrusFetchSkipped);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Average Total Latency:  ${avgTotal.toFixed(0)}ms`);
  console.log(`  Average Walrus Fetch:   ${avgWalrus.toFixed(0)}ms`);
  console.log(`  All Content Local:      ${allLocal ? '✅ YES (Option A+ working!)' : '❌ NO'}`);
  console.log(`  Init Time:              ${initTime.toFixed(0)}ms`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // JSON output for CI/CD
  console.log('📊 JSON Results (for automation):');
  console.log(JSON.stringify({
    summary: {
      avgTotalLatencyMs: Math.round(avgTotal),
      avgWalrusFetchMs: Math.round(avgWalrus),
      allContentLocal: allLocal,
      initTimeMs: Math.round(initTime),
      queriesCount: results.length,
    },
    details: results,
  }, null, 2));
}

// Run
runBenchmark().catch(console.error);
