/**
 * MemWal client factory — creates mock or real SDK client.
 * Real SDK loaded lazily via dynamic import(), cached after first load.
 */

import { createMockClient } from "./mock.js";
import type { PluginConfig, MemWalClient } from "./types.js";

/** Cached real SDK module — loaded once, null in mock mode. */
let _realSdk: { MemWal: any } | null = null;

/**
 * Create a MemWal client for the given key + accountId.
 * Mock mode returns an in-memory client. Live mode uses the real SDK.
 * Real SDK is loaded lazily on first call, then cached.
 */
export async function createClient(
  key: string,
  accountId: string,
  config: PluginConfig,
): Promise<MemWalClient> {
  if (config.mock) {
    return createMockClient(key);
  }

  if (!_realSdk) {
    _realSdk = await import("@cmdoss/memwal");
  }
  return _realSdk.MemWal.create({ key, accountId, serverUrl: config.serverUrl });
}
