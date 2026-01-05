/**
 * SDK Memory Test - Tests memory management without blockchain transactions
 *
 * This test simulates the SDK's memory usage patterns to verify:
 * 1. LRU cache eviction works correctly
 * 2. Memory doesn't grow unbounded
 * 3. Idle indexes are cleaned up
 */

import { HnswWasmService } from '../packages/memwal-sdk/src/vector/HnswWasmService';

// Mock storage service for testing
const mockStorageService = {
  async uploadToWalrus(data: Uint8Array): Promise<{ blobId: string }> {
    return { blobId: `mock-blob-${Date.now()}` };
  },
  async fetchFromWalrus(blobId: string): Promise<Uint8Array> {
    return new Uint8Array(0);
  },
};

async function runMemoryTest() {
  console.log('🧪 SDK Memory Test Starting...\n');

  // Create service with strict memory limits for testing
  const service = new HnswWasmService(
    mockStorageService as any,
    { dimension: 384, maxElements: 1000 },
    { maxBatchSize: 10, batchDelayMs: 1000 },
    {
      maxCachedIndexes: 3,  // Only keep 3 indexes
      indexTtlMs: 5000,      // 5 second TTL
      maxMemoryMB: 50,       // 50MB limit
    }
  );

  // Wait for WASM to initialize
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log('📊 Initial cache stats:', service.getCacheStats());

  // Simulate multiple users creating indexes
  const userAddresses = [
    '0xuser1_test',
    '0xuser2_test',
    '0xuser3_test',
    '0xuser4_test',
    '0xuser5_test',
  ];

  // Generate random vectors
  const generateVector = (dim: number) =>
    Array.from({ length: dim }, () => Math.random());

  console.log('\n🔄 Creating indexes for 5 users (max cache: 3)...\n');

  for (let i = 0; i < userAddresses.length; i++) {
    const user = userAddresses[i];
    console.log(`Creating index for ${user}...`);

    try {
      // Create index
      await service.createIndex(user, { dimension: 384 });

      // Add some vectors
      for (let j = 0; j < 10; j++) {
        service.addVectorToIndexBatched(user, j, generateVector(384), {
          content: `Memory ${j} for ${user}`,
        });
      }

      // Flush to process batch
      await service.forceFlush(user);

      const stats = service.getCacheStats();
      console.log(`  ✅ Added 10 vectors. Cache: ${stats.totalUsers}/${stats.maxCachedIndexes} indexes, ${stats.memoryUsageMB.toFixed(2)}MB`);

      // After 3 users, we should see eviction
      if (i >= 2) {
        console.log(`  🧹 LRU should have evicted oldest index`);
      }
    } catch (error) {
      console.error(`  ❌ Error for ${user}:`, error);
    }

    // Small delay between users
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n📊 Final cache stats:', service.getCacheStats());

  // Verify eviction worked
  const finalStats = service.getCacheStats();
  if (finalStats.totalUsers <= 3) {
    console.log('\n✅ LRU eviction working correctly!');
  } else {
    console.log('\n❌ LRU eviction NOT working - cache exceeded limit');
  }

  // Test TTL expiration
  console.log('\n⏳ Waiting 6 seconds for TTL expiration (5s TTL)...');
  await new Promise(resolve => setTimeout(resolve, 6000));

  // Access one user to keep it alive, let others expire
  try {
    const results = await service.search(userAddresses[4], generateVector(384), { k: 5 });
    console.log(`  Kept ${userAddresses[4]} alive with search`);
  } catch {
    // May fail if index doesn't exist
  }

  // Wait for cleanup interval
  await new Promise(resolve => setTimeout(resolve, 2000));

  const postTtlStats = service.getCacheStats();
  console.log('\n📊 Post-TTL cache stats:', postTtlStats);

  if (postTtlStats.totalUsers < finalStats.totalUsers) {
    console.log('✅ TTL expiration working correctly!');
  }

  // Cleanup
  service.destroy();
  console.log('\n🏁 Test complete!');
}

// Run the test
runMemoryTest().catch(console.error);
