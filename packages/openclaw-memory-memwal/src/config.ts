/**
 * Config parsing, validation, and per-agent key resolution.
 */

import type { PluginConfig, AgentKeyConfig } from "./types.js";

// ============================================================================
// Defaults
// ============================================================================

const DEFAULTS: Omit<PluginConfig, "privateKey" | "accountId" | "serverUrl"> = {
  agentKeys: {},
  mock: false,
  autoRecall: true,
  autoCapture: true,
  maxRecallResults: 5,
  minRelevance: 0.3,
  captureMaxMessages: 10,
};

// ============================================================================
// Env Var Resolution
// ============================================================================

function resolveEnvVar(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const v = process.env[name];
    if (!v) throw new Error(`Environment variable ${name} is not set`);
    return v;
  });
}

// ============================================================================
// Config Parser
// ============================================================================

export function parseConfig(raw: unknown): PluginConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("memory-memwal: config is required");
  }
  const cfg = raw as Record<string, unknown>;

  // Mock mode — relax requirements
  const mock = cfg.mock === true;

  // Required fields (relaxed in mock mode)
  const privateKey = typeof cfg.privateKey === "string" && cfg.privateKey
    ? resolveEnvVar(cfg.privateKey)
    : mock
      ? "mock-default-key"
      : (() => { throw new Error("memory-memwal: privateKey is required"); })();

  const accountId = typeof cfg.accountId === "string" && cfg.accountId
    ? resolveEnvVar(cfg.accountId)
    : mock
      ? "mock-account-id"
      : (() => { throw new Error("memory-memwal: accountId is required"); })();

  const serverUrl = typeof cfg.serverUrl === "string" && cfg.serverUrl
    ? resolveEnvVar(cfg.serverUrl)
    : mock
      ? "http://mock"
      : (() => { throw new Error("memory-memwal: serverUrl is required"); })();

  // Resolve env vars in agent keys (each entry has key + accountId)
  const rawAgentKeys = (cfg.agentKeys ?? {}) as Record<string, any>;
  const agentKeys: Record<string, AgentKeyConfig> = {};
  for (const [name, val] of Object.entries(rawAgentKeys)) {
    if (val && typeof val === "object" && typeof val.key === "string" && typeof val.accountId === "string") {
      agentKeys[name] = {
        key: mock ? val.key : resolveEnvVar(val.key),
        accountId: mock ? val.accountId : resolveEnvVar(val.accountId),
      };
    }
  }

  return {
    privateKey,
    accountId,
    serverUrl,
    agentKeys,
    mock,
    autoRecall: typeof cfg.autoRecall === "boolean" ? cfg.autoRecall : DEFAULTS.autoRecall,
    autoCapture: typeof cfg.autoCapture === "boolean" ? cfg.autoCapture : DEFAULTS.autoCapture,
    maxRecallResults: typeof cfg.maxRecallResults === "number"
      ? cfg.maxRecallResults
      : DEFAULTS.maxRecallResults,
    minRelevance: typeof cfg.minRelevance === "number"
      ? cfg.minRelevance
      : DEFAULTS.minRelevance,
    captureMaxMessages: typeof cfg.captureMaxMessages === "number"
      ? cfg.captureMaxMessages
      : DEFAULTS.captureMaxMessages,
  };
}

// ============================================================================
// Key Resolution
// ============================================================================

export interface ResolvedKey {
  key: string;
  accountId: string;
}

/**
 * Resolve which Ed25519 key + accountId to use based on the current agent.
 *
 * Parses agent name from OpenClaw's sessionKey format: "agent:<name>:<uuid>"
 * Looks up in agentKeys map, falls back to default privateKey + accountId.
 *
 * Isolation depends on HOW keys were generated:
 * - Keys from same MemWalAccount → shared memory (same owner on server)
 * - Keys from different MemWalAccounts → isolated memory (different owners)
 */
export function resolveKey(config: PluginConfig, sessionKey?: string): ResolvedKey {
  if (!sessionKey) return { key: config.privateKey, accountId: config.accountId };

  const match = sessionKey.match(/^agent:([^:]+):/);
  const agentName = match?.[1];

  if (!agentName || agentName === "main") return { key: config.privateKey, accountId: config.accountId };
  if (config.agentKeys[agentName]) return config.agentKeys[agentName];

  return { key: config.privateKey, accountId: config.accountId };
}

/**
 * Get agent name from session key for logging.
 */
export function resolveAgentName(sessionKey?: string): string {
  if (!sessionKey) return "main";
  const match = sessionKey.match(/^agent:([^:]+):/);
  return match?.[1] ?? "main";
}

/**
 * Format key for safe logging (first 4 + last 4 chars).
 */
export function keyPreview(key: string): string {
  if (key.startsWith("mock")) return "mock";
  return key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : "****";
}
