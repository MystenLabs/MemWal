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
// Namespace Resolution
// ============================================================================

/**
 * Resolve namespace from OpenClaw's sessionKey.
 *
 * Parses agent name from format "agent:<name>:<uuid>".
 * Each agent gets its own namespace for memory isolation.
 * Falls back to defaultNamespace for main agent or unknown sessions.
 */
export function resolveNamespace(defaultNamespace: string, sessionKey?: string): string {
  if (!sessionKey) return defaultNamespace;

  const match = sessionKey.match(/^agent:([^:]+):/);
  const agentName = match?.[1];

  if (!agentName || agentName === "main") return defaultNamespace;
  return agentName;
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
  return key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : "****";
}
