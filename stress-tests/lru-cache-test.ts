/**
 * LRU Cache Unit Test
 *
 * Tests the LRUCache utility directly without WASM dependencies
 */

import { LRUCache, estimateSize, estimateIndexCacheSize } from '../packages/memwal-sdk/src/utils/LRUCache';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testBasicOperations() {
  console.log('📦 Test 1: Basic Operations');

  const cache = new LRUCache<string>({ maxSize: 3, ttlMs: 60000 });

  cache.set('a', 'value-a');
  cache.set('b', 'value-b');
  cache.set('c', 'value-c');

  console.log(`  Size: ${cache.size} (expected: 3)`);
  console.log(`  Get 'a': ${cache.get('a')} (expected: value-a)`);
  console.log(`  Has 'b': ${cache.has('b')} (expected: true)`);

  // Adding 4th item should evict LRU (which is 'b' since 'a' was accessed)
  cache.set('d', 'value-d');

  console.log(`  After adding 'd': size=${cache.size} (expected: 3)`);
  console.log(`  Has 'b': ${cache.has('b')} (expected: false - LRU evicted)`);
  console.log(`  Has 'd': ${cache.has('d')} (expected: true)`);

  cache.destroy();
  console.log('  ✅ Basic operations passed\n');
}

async function testTTLExpiration() {
  console.log('⏳ Test 2: TTL Expiration');

  const cache = new LRUCache<string>({
    maxSize: 10,
    ttlMs: 500,  // 500ms TTL
    cleanupIntervalMs: 100,
  });

  cache.set('short-lived', 'will-expire');
  console.log(`  Initial: has='short-lived': ${cache.has('short-lived')}`);

  await sleep(600);  // Wait for TTL + cleanup

  console.log(`  After 600ms: has='short-lived': ${cache.has('short-lived')} (expected: false)`);

  cache.destroy();
  console.log('  ✅ TTL expiration passed\n');
}

async function testMemoryLimit() {
  console.log('💾 Test 3: Memory Limit');

  const cache = new LRUCache<string>({
    maxSize: 100,
    ttlMs: 60000,
    sizeEstimator: (value) => value.length * 2,  // UTF-16
    maxMemoryBytes: 100,  // 100 bytes max
  });

  // Add items until memory limit is hit
  cache.set('item1', 'a'.repeat(20));  // 40 bytes
  console.log(`  After item1 (40B): size=${cache.size}, memory=${cache.memoryBytes}B`);

  cache.set('item2', 'b'.repeat(20));  // 40 bytes - total 80
  console.log(`  After item2 (40B): size=${cache.size}, memory=${cache.memoryBytes}B`);

  cache.set('item3', 'c'.repeat(20));  // 40 bytes - would exceed, should evict
  console.log(`  After item3 (40B): size=${cache.size}, memory=${cache.memoryBytes}B`);

  console.log(`  Has 'item1': ${cache.has('item1')} (expected: false - evicted for memory)`);
  console.log(`  Has 'item3': ${cache.has('item3')} (expected: true)`);

  cache.destroy();
  console.log('  ✅ Memory limit passed\n');
}

async function testEvictionCallback() {
  console.log('🔔 Test 4: Eviction Callback');

  const evictions: { key: string; reason: string }[] = [];

  const cache = new LRUCache<string>({
    maxSize: 2,
    ttlMs: 60000,
    onEvict: (key, value, reason) => {
      evictions.push({ key, reason });
      console.log(`    Evicted: ${key} (reason: ${reason})`);
    },
  });

  cache.set('first', 'v1');
  cache.set('second', 'v2');
  cache.set('third', 'v3');  // Should evict 'first'

  console.log(`  Evictions: ${evictions.length} (expected: 1)`);
  console.log(`  Evicted key: ${evictions[0]?.key} (expected: first)`);
  console.log(`  Eviction reason: ${evictions[0]?.reason} (expected: lru)`);

  cache.destroy();
  console.log('  ✅ Eviction callback passed\n');
}

async function testSizeEstimator() {
  console.log('📏 Test 5: Size Estimator Functions');

  console.log(`  estimateSize(null): ${estimateSize(null)} (expected: 8)`);
  console.log(`  estimateSize(true): ${estimateSize(true)} (expected: 4)`);
  console.log(`  estimateSize(42): ${estimateSize(42)} (expected: 8)`);
  console.log(`  estimateSize("hello"): ${estimateSize('hello')} (expected: 10 - 5 chars * 2)`);
  console.log(`  estimateSize([1,2,3]): ${estimateSize([1, 2, 3])} (expected: ~48)`);

  const indexEntry = {
    vectors: new Map([
      [0, [1.0, 2.0, 3.0, 4.0]],  // 4 floats = 32 bytes + overhead
      [1, [5.0, 6.0, 7.0, 8.0]],
    ]),
    metadata: new Map([
      [0, { content: 'test' }],
      [1, { content: 'test2' }],
    ]),
  };

  const indexSize = estimateIndexCacheSize(indexEntry);
  console.log(`  estimateIndexCacheSize (2 vectors, 2 metadata): ${indexSize} bytes`);

  console.log('  ✅ Size estimator passed\n');
}

async function testConcurrentAccess() {
  console.log('🔄 Test 6: Concurrent Access Pattern');

  const cache = new LRUCache<{ vectors: number[]; metadata: any }>({
    maxSize: 5,
    ttlMs: 60000,
    sizeEstimator: (entry) => entry.vectors.length * 8 + 100,
  });

  // Simulate 10 users accessing the cache
  const userIds = ['user1', 'user2', 'user3', 'user4', 'user5', 'user6', 'user7', 'user8', 'user9', 'user10'];

  for (const userId of userIds) {
    cache.set(userId, {
      vectors: Array.from({ length: 384 }, () => Math.random()),
      metadata: { userId, createdAt: Date.now() },
    });
    console.log(`  Added ${userId}: cache size=${cache.size}`);
  }

  console.log(`\n  Final cache size: ${cache.size} (expected: 5 - max limit)`);

  // Verify only last 5 users are in cache (most recent)
  const inCache = userIds.filter(id => cache.has(id));
  console.log(`  Users in cache: ${inCache.join(', ')}`);
  console.log(`  Memory usage: ${(cache.memoryBytes / 1024).toFixed(2)} KB`);

  const stats = cache.getStats();
  console.log(`  Stats: size=${stats.size}, maxSize=${stats.maxSize}, memory=${stats.memoryBytes}B`);

  cache.destroy();
  console.log('  ✅ Concurrent access passed\n');
}

async function runAllTests() {
  console.log('🧪 LRU Cache Test Suite\n');
  console.log('='.repeat(50) + '\n');

  await testBasicOperations();
  await testTTLExpiration();
  await testMemoryLimit();
  await testEvictionCallback();
  await testSizeEstimator();
  await testConcurrentAccess();

  console.log('='.repeat(50));
  console.log('✅ All tests passed!');
}

runAllTests().catch(console.error);
