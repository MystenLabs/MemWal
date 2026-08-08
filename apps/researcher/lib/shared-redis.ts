import "server-only";

import { createClient } from "redis";

const REDIS_CONNECT_TIMEOUT_MS = 1000;
const REDIS_MAX_RECONNECT_ATTEMPTS = 2;

let client: ReturnType<typeof createClient> | null = null;
let connectPromise: Promise<void> | null = null;

export class SharedRedisUnavailableError extends Error {
  constructor() {
    super("Shared Redis is unavailable");
    this.name = "SharedRedisUnavailableError";
  }
}

export async function getSharedRedisClient() {
  if (!client) {
    const url = process.env.REDIS_URL;
    if (!url) {
      return null;
    }

    client = createClient({
      disableOfflineQueue: true,
      socket: {
        connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
        reconnectStrategy: (retries) => {
          if (retries >= REDIS_MAX_RECONNECT_ATTEMPTS) {
            return false;
          }
          return Math.min(50 * 2 ** retries, 200);
        },
      },
      url,
    });
    client.on("error", () => undefined);
  }

  if (!client.isOpen && !connectPromise) {
    connectPromise = client.connect().then(() => undefined);
  }

  if (connectPromise) {
    try {
      await connectPromise;
    } catch {
      client = null;
    } finally {
      connectPromise = null;
    }
  }

  return client?.isReady ? client : null;
}

export async function requireSharedRedisClient() {
  const redis = await getSharedRedisClient();
  if (!redis) {
    throw new SharedRedisUnavailableError();
  }
  return redis;
}
