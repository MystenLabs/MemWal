/**
 * Shared types for the MemWal OpenClaw plugin.
 */

export interface PluginConfig {
  /** Ed25519 private key (hex). */
  privateKey: string;
  /** MemWalAccount object ID on Sui. */
  accountId: string;
  /** MemWal server URL. */
  serverUrl: string;
  /** Default namespace for memory scoping (default: "default"). */
  defaultNamespace: string;
  /** Auto-inject relevant memories before each agent turn. */
  autoRecall: boolean;
  /** Auto-extract and store facts after each agent turn. */
  autoCapture: boolean;
  /** Max memories to inject per auto-recall. */
  maxRecallResults: number;
  /** Min relevance threshold (0-1) for auto-recall filtering. */
  minRelevance: number;
  /** Number of recent messages to send for auto-capture. */
  captureMaxMessages: number;
}
