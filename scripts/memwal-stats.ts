#!/usr/bin/env npx tsx
/**
 * MemWal Statistics Script - Mainnet
 *
 * Queries Sui RPC to gather on-chain statistics about MemWal usage.
 * All data is verified by checking memwal_package_id in blob metadata.
 *
 * Usage: npx tsx scripts/memwal-stats.ts
 */

// ============================================================
// Configuration
// ============================================================

const IS_TESTNET = process.argv.includes("--testnet");

const CONFIG = IS_TESTNET
  ? {
      network: "testnet",
      rpcUrl: "https://fullnode.testnet.sui.io:443",
      packageId: "0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6",
      registryId: "0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437",
      walrusBlobType: "0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66::blob::Blob",
    }
  : {
      network: "mainnet",
      rpcUrl: "https://fullnode.mainnet.sui.io:443",
      packageId: "0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6",
      registryId: "0x0da982cefa26864ae834a8a0504b904233d49e20fcc17c373c8bed99c75a7edd",
      walrusBlobType: "0xfdc88f7d7cf30afab2f82e8380d11ee8f70efb90e863d1de8616fae1bb09ea77::blob::Blob",
    };

// Event types
const ACCOUNT_CREATED_EVENT = `${CONFIG.packageId}::account::AccountCreated`;
const DELEGATE_KEY_ADDED_EVENT = `${CONFIG.packageId}::account::DelegateKeyAdded`;
const DELEGATE_KEY_REMOVED_EVENT = `${CONFIG.packageId}::account::DelegateKeyRemoved`;

// ============================================================
// Types
// ============================================================

interface AccountCreatedEvent {
  account_id: string;
  owner: string;
}

interface DelegateKeyEvent {
  account_id: string;
  public_key: number[];
  sui_address: string;
  label?: string;
}

interface EventCursor {
  txDigest: string;
  eventSeq: string;
}

interface AccountStats {
  accountId: string;
  owner: string;
  agentCount: number;
  memoryCount: number;
  storageBytes: number;
  contentBytes: number;
  namespaces: string[];
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log("\n");
  console.log("  ╔══════════════════════════════════════════════════════════╗");
  console.log("  ║                                                          ║");
  console.log("  ║   🧠 MemWal On-Chain Statistics                          ║");
  console.log(`  ║   ${CONFIG.network.toUpperCase().padEnd(7)} · Real-time Data                               ║`);
  console.log("  ║                                                          ║");
  console.log("  ╚══════════════════════════════════════════════════════════╝\n");

  // 1. Query all AccountCreated events
  process.stdout.write("  📊 Fetching accounts...");
  const accounts = await queryAllEvents<AccountCreatedEvent>(ACCOUNT_CREATED_EVENT);
  console.log(` found ${accounts.length}`);

  // 2. Query DelegateKeyAdded/Removed events
  process.stdout.write("  📊 Fetching agents...");
  const delegateKeysAdded = await queryAllEvents<DelegateKeyEvent>(DELEGATE_KEY_ADDED_EVENT);
  const delegateKeysRemoved = await queryAllEvents<DelegateKeyEvent>(DELEGATE_KEY_REMOVED_EVENT);

  // Calculate current delegate key count per account
  const delegateKeysByAccount = new Map<string, Set<string>>();
  for (const event of delegateKeysAdded) {
    const accountId = event.account_id;
    const keyHex = arrayToHex(event.public_key);
    if (!delegateKeysByAccount.has(accountId)) {
      delegateKeysByAccount.set(accountId, new Set());
    }
    delegateKeysByAccount.get(accountId)!.add(keyHex);
  }
  for (const event of delegateKeysRemoved) {
    const accountId = event.account_id;
    const keyHex = arrayToHex(event.public_key);
    if (delegateKeysByAccount.has(accountId)) {
      delegateKeysByAccount.get(accountId)!.delete(keyHex);
    }
  }
  const totalAgents = Array.from(delegateKeysByAccount.values()).reduce((sum, set) => sum + set.size, 0);
  console.log(` found ${totalAgents}`);

  // 3. Query memories for each owner
  console.log("  📊 Scanning memories (this may take a minute)...\n");

  const accountStats: AccountStats[] = [];
  const namespaceCount = new Map<string, number>();
  let totalMemories = 0;
  let totalStorageBytes = 0;
  let totalContentBytes = 0;

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const keys = delegateKeysByAccount.get(account.account_id);
    const agentCount = keys ? keys.size : 0;

    // Query blobs for this owner
    process.stdout.write(`     [${i + 1}/${accounts.length}] Querying blobs for ${account.owner.slice(0, 10)}...`);
    const blobs = await queryBlobsForOwner(account.owner);
    process.stdout.write(` found ${blobs.length}, checking metadata...\r`);

    let memoryCount = 0;
    let storageBytes = 0;
    let contentBytes = 0;
    const namespaces = new Set<string>();

    for (const blob of blobs) {
      const objectId = blob.data?.objectId;
      const fields = blob.data?.content?.fields;

      // Fetch and verify metadata
      const metadata = await fetchBlobMetadata(objectId);

      if (metadata.memwal_package_id === CONFIG.packageId) {
        memoryCount++;
        storageBytes += parseInt(fields?.storage?.fields?.storage_size || "0", 10);
        contentBytes += parseInt(fields?.size || "0", 10);

        const ns = metadata.memwal_namespace || "default";
        namespaces.add(ns);
        namespaceCount.set(ns, (namespaceCount.get(ns) || 0) + 1);
      }

      await sleep(50);
    }

    accountStats.push({
      accountId: account.account_id,
      owner: account.owner,
      agentCount,
      memoryCount,
      storageBytes,
      contentBytes,
      namespaces: Array.from(namespaces),
    });

    totalMemories += memoryCount;
    totalStorageBytes += storageBytes;
    totalContentBytes += contentBytes;

    process.stdout.write(`     Progress: ${i + 1}/${accounts.length} accounts | ${totalMemories} memories found\r`);
    await sleep(100);
  }

  console.log("\n");

  // Sort by memories descending
  accountStats.sort((a, b) => b.memoryCount - a.memoryCount);

  // Calculate interesting stats
  const activeAccounts = accountStats.filter(a => a.memoryCount > 0).length;
  const avgMemoriesPerActive = activeAccounts > 0 ? totalMemories / activeAccounts : 0;
  const maxMemories = accountStats[0]?.memoryCount || 0;
  const avgAgentsPerAccount = accounts.length > 0 ? totalAgents / accounts.length : 0;

  // Distribution
  const with1to10 = accountStats.filter(a => a.memoryCount >= 1 && a.memoryCount <= 10).length;
  const with11to50 = accountStats.filter(a => a.memoryCount >= 11 && a.memoryCount <= 50).length;
  const with51to100 = accountStats.filter(a => a.memoryCount >= 51 && a.memoryCount <= 100).length;
  const with100plus = accountStats.filter(a => a.memoryCount > 100).length;

  // Print summary
  console.log("  ┌────────────────────────────────────────────────────────────┐");
  console.log("  │                     📈 KEY METRICS                         │");
  console.log("  ├────────────────────────────────────────────────────────────┤");
  console.log(`  │  Total Accounts          │  ${String(accounts.length).padStart(8)}                      │`);
  console.log(`  │  Active Accounts         │  ${String(activeAccounts).padStart(8)}  (${((activeAccounts/accounts.length)*100).toFixed(0)}% activation)   │`);
  console.log(`  │  Total Agents            │  ${String(totalAgents).padStart(8)}                      │`);
  console.log(`  │  Total Memories          │  ${String(totalMemories).padStart(8)}                      │`);
  console.log("  ├────────────────────────────────────────────────────────────┤");
  console.log(`  │  Walrus Storage          │  ${formatBytes(totalStorageBytes).padStart(10)}                    │`);
  console.log(`  │  Content Size            │  ${formatBytes(totalContentBytes).padStart(10)}                    │`);
  console.log("  └────────────────────────────────────────────────────────────┘\n");

  console.log("  ┌────────────────────────────────────────────────────────────┐");
  console.log("  │                   📊 USAGE PATTERNS                        │");
  console.log("  ├────────────────────────────────────────────────────────────┤");
  console.log(`  │  Avg Memories/Active User    │  ${avgMemoriesPerActive.toFixed(1).padStart(8)}               │`);
  console.log(`  │  Avg Agents/Account          │  ${avgAgentsPerAccount.toFixed(1).padStart(8)}               │`);
  console.log(`  │  Power User (max memories)   │  ${String(maxMemories).padStart(8)}               │`);
  console.log("  ├────────────────────────────────────────────────────────────┤");
  console.log("  │  User Distribution:                                        │");
  console.log(`  │    • 1-10 memories           │  ${String(with1to10).padStart(4)} accounts            │`);
  console.log(`  │    • 11-50 memories          │  ${String(with11to50).padStart(4)} accounts            │`);
  console.log(`  │    • 51-100 memories         │  ${String(with51to100).padStart(4)} accounts            │`);
  console.log(`  │    • 100+ memories           │  ${String(with100plus).padStart(4)} accounts            │`);
  console.log("  └────────────────────────────────────────────────────────────┘\n");

  // Namespace breakdown
  if (namespaceCount.size > 0) {
    const sortedNamespaces = Array.from(namespaceCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    console.log("  ┌────────────────────────────────────────────────────────────┐");
    console.log("  │                   🏷️  TOP NAMESPACES                       │");
    console.log("  ├────────────────────────────────────────────────────────────┤");
    for (const [ns, count] of sortedNamespaces) {
      const displayNs = ns.length > 30 ? ns.slice(0, 27) + "..." : ns;
      const percentage = ((count / totalMemories) * 100).toFixed(1);
      console.log(`  │  ${displayNs.padEnd(32)} │  ${String(count).padStart(5)} (${percentage.padStart(5)}%)  │`);
    }
    console.log("  └────────────────────────────────────────────────────────────┘\n");
  }

  // Top users
  const topUsers = accountStats.filter(a => a.memoryCount > 0).slice(0, 5);
  if (topUsers.length > 0) {
    console.log("  ┌────────────────────────────────────────────────────────────┐");
    console.log("  │                   🏆 TOP USERS                             │");
    console.log("  ├────────────────────────────────────────────────────────────┤");
    for (let i = 0; i < topUsers.length; i++) {
      const user = topUsers[i];
      const shortAddr = user.owner.slice(0, 8) + "..." + user.owner.slice(-6);
      const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "  ";
      console.log(`  │  ${medal} ${shortAddr}  │  ${String(user.memoryCount).padStart(5)} memories  │  ${String(user.agentCount).padStart(2)} agents  │`);
    }
    console.log("  └────────────────────────────────────────────────────────────┘\n");
  }

  // Export as JSON
  const outputPath = "./scripts/memwal-stats-output.json";
  const output = {
    timestamp: new Date().toISOString(),
    network: CONFIG.network,
    packageId: CONFIG.packageId,
    summary: {
      totalAccounts: accounts.length,
      activeAccounts,
      totalAgents,
      totalMemories,
      totalStorageBytes,
      totalContentBytes,
      totalStorageFormatted: formatBytes(totalStorageBytes),
      totalContentFormatted: formatBytes(totalContentBytes),
      avgMemoriesPerActiveUser: Math.round(avgMemoriesPerActive * 10) / 10,
      avgAgentsPerAccount: Math.round(avgAgentsPerAccount * 10) / 10,
    },
    namespaceBreakdown: Object.fromEntries(namespaceCount),
    topUsers: topUsers.map(u => ({
      owner: u.owner,
      memories: u.memoryCount,
      agents: u.agentCount,
    })),
    accounts: accountStats,
  };

  const fs = await import("fs/promises");
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log(`  💾 Full data exported to: ${outputPath}\n`);
}

// ============================================================
// Helpers
// ============================================================

async function queryAllEvents<T>(eventType: string): Promise<T[]> {
  const events: T[] = [];
  let cursor: EventCursor | null = null;

  while (true) {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "suix_queryEvents",
      params: [{ MoveEventType: eventType }, cursor, 50, false],
    };

    const response = await fetch(CONFIG.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const json = (await response.json()) as any;

    if (json.error) {
      throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
    }

    for (const event of json.result?.data || []) {
      events.push(event.parsedJson);
    }

    if (!json.result?.hasNextPage) break;
    cursor = json.result?.nextCursor;
    await sleep(100);
  }

  return events;
}

async function queryBlobsForOwner(owner: string): Promise<any[]> {
  let blobs: any[] = [];
  let cursor: string | null = null;

  while (true) {
    const params: any[] = [
      owner,
      {
        filter: { StructType: CONFIG.walrusBlobType },
        options: { showContent: true },
      },
    ];
    if (cursor) params.push(cursor);

    const json = await fetchWithRetry({
      jsonrpc: "2.0",
      id: 1,
      method: "suix_getOwnedObjects",
      params,
    });

    blobs = blobs.concat(json.result?.data || []);

    if (!json.result?.hasNextPage) break;
    cursor = json.result?.nextCursor;
    await sleep(100);
  }

  return blobs;
}

async function fetchBlobMetadata(objectId: string): Promise<Record<string, string>> {
  const json = await fetchWithRetry({
    jsonrpc: "2.0",
    id: 1,
    method: "suix_getDynamicFieldObject",
    params: [
      objectId,
      {
        type: "vector<u8>",
        value: [109, 101, 116, 97, 100, 97, 116, 97], // "metadata"
      },
    ],
  });

  // Parse metadata from dynamic field
  const contents =
    json.result?.data?.content?.fields?.value?.fields?.metadata?.fields?.contents || [];
  const metadata: Record<string, string> = {};

  for (const entry of contents) {
    if (entry?.fields?.key && entry?.fields?.value) {
      metadata[entry.fields.key] = entry.fields.value;
    }
  }

  return metadata;
}

function arrayToHex(arr: number[]): string {
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchWithRetry(body: any, retries = 3): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(CONFIG.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const text = await response.text();

      // Check if it's an error response (not JSON)
      if (!text.startsWith("{") && !text.startsWith("[")) {
        if (attempt < retries) {
          await sleep(1000 * attempt); // Exponential backoff
          continue;
        }
        throw new Error(`RPC returned non-JSON: ${text.slice(0, 100)}`);
      }

      return JSON.parse(text);
    } catch (err: any) {
      if (attempt < retries) {
        await sleep(1000 * attempt);
        continue;
      }
      throw err;
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run
main().catch(console.error);
