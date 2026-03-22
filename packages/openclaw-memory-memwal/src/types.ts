/**
 * Shared types for the MemWal OpenClaw plugin.
 */

// ============================================================================
// Plugin Config
// ============================================================================

export interface AgentKeyConfig {
  /** Ed25519 private key (hex) */
  key: string;
  /** MemWalAccount object ID on Sui */
  accountId: string;
}

export interface PluginConfig {
  /** Default Ed25519 private key (hex). Used when no agent-specific key exists. */
  privateKey: string;
  /** Default MemWalAccount object ID on Sui. */
  accountId: string;
  /** MemWal server URL. Ignored in mock mode. */
  serverUrl: string;
  /** Per-agent key+account mapping. Keys from different MemWalAccounts = isolated memory. */
  agentKeys: Record<string, AgentKeyConfig>;
  /** Enable mock mode (in-memory storage, no real server). */
  mock: boolean;
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

// ============================================================================
// MemWal Client Interface (shared by real SDK and mock)
// ============================================================================

export interface RememberResult {
  id: string;
  blob_id: string;
  owner: string;
}

export interface RecallMemory {
  blob_id: string;
  text: string;
  distance: number;
}

export interface RecallResult {
  results: RecallMemory[];
  total: number;
}

export interface AnalyzedFact {
  text: string;
  id: string;
  blob_id: string;
}

export interface AnalyzeResult {
  facts: AnalyzedFact[];
  total: number;
  owner: string;
}

export interface HealthResult {
  status: string;
  version: string;
}

export interface MemWalClient {
  remember(text: string): Promise<RememberResult>;
  recall(query: string, limit?: number): Promise<RecallResult>;
  analyze(text: string): Promise<AnalyzeResult>;
  health(): Promise<HealthResult>;
}
