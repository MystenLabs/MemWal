/**
 * Config parsing, validation, and namespace resolution.
 */

import type { PluginConfig } from "./types.js";

// ============================================================================
// Defaults
// ============================================================================

const DEFAULTS = {
  defaultNamespace: "default",
  autoRecall: true,
  autoCapture: true,
  maxRecallResults: 5,
  minRelevance: 0.3,
  captureMaxMessages: 10,
};

// ============================================================================
// Env Var Resolution
// ============================================================================

/** Replace ${ENV_VAR} placeholders with process.env values. */
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

/**
 * Parse and validate raw plugin config from openclaw.json.
 *
 * Resolves ${ENV_VAR} placeholders in string fields and applies defaults
 * for optional settings. Throws on missing required fields.
 *
 * @param raw - Raw config object from `api.pluginConfig`
 * @returns Validated config with all defaults applied
 * @throws {Error} If privateKey, accountId, or serverUrl is missing
 */
export function parseConfig(raw: unknown): PluginConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("memory-memwal: config is required");
  }
  const cfg = raw as Record<string, unknown>;

  const privateKey = typeof cfg.privateKey === "string" && cfg.privateKey
    ? resolveEnvVar(cfg.privateKey)
    : (() => { throw new Error("memory-memwal: privateKey is required"); })();

  const accountId = typeof cfg.accountId === "string" && cfg.accountId
    ? resolveEnvVar(cfg.accountId)
    : (() => { throw new Error("memory-memwal: accountId is required"); })();

  const serverUrl = typeof cfg.serverUrl === "string" && cfg.serverUrl
    ? resolveEnvVar(cfg.serverUrl)
    : (() => { throw new Error("memory-memwal: serverUrl is required"); })();

  return {
    privateKey,
    accountId,
    serverUrl,
    defaultNamespace: typeof cfg.defaultNamespace === "string"
      ? cfg.defaultNamespace
      : DEFAULTS.defaultNamespace,
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
// Agent + Namespace Resolution
// ============================================================================

export interface ResolvedAgent {
  namespace: string;
  agentName: string;
}

/**
 * Resolve agent name and namespace from OpenClaw's sessionKey.
 *
 * Parses agent name from format "agent:\<name\>:\<uuid\>".
 * Each agent gets its own namespace for memory isolation.
 * Falls back to defaultNamespace for main agent or unknown sessions.
 *
 * @param defaultNamespace - Fallback namespace (used for main agent)
 * @param sessionKey - OpenClaw session key, e.g. "agent:researcher:uuid-456"
 * @returns Resolved namespace and human-readable agent name
 */
export function resolveAgent(defaultNamespace: string, sessionKey?: string): ResolvedAgent {
  if (!sessionKey) return { namespace: defaultNamespace, agentName: "main" };

  const match = sessionKey.match(/^agent:([^:]+):/);
  const name = match?.[1];

  if (!name || name === "main") return { namespace: defaultNamespace, agentName: "main" };
  return { namespace: name, agentName: name };
}

/**
 * Format key for safe logging (first 4 + last 4 chars).
 */
export function keyPreview(key: string): string {
  return key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : "****";
}
