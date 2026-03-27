/**
 * Config parsing, validation, and namespace resolution.
 *
 * Uses Zod for schema validation — all config errors surface at startup
 * with clear messages instead of failing at runtime.
 */

import { z } from "zod";
import type { PluginConfig } from "./types.js";

// ============================================================================
// Schema
// ============================================================================

const ConfigSchema = z.object({
  privateKey: z.string()
    .min(1, "required")
    .regex(/^[0-9a-fA-F]{64}$/, "must be a 64-character hex string (delegate key)"),
  accountId: z.string()
    .min(1, "required")
    .regex(/^0x[0-9a-fA-F]{10,}$/, "must be a Sui object ID (0x...)"),
  serverUrl: z.string()
    .min(1, "required")
    .url("must be a valid URL"),
  defaultNamespace: z.string().default("default"),
  autoRecall: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  maxRecallResults: z.number().min(1).max(20).default(5),
  minRelevance: z.number().min(0).max(1).default(0.3),
  captureMaxMessages: z.number().min(1).max(50).default(10),
});

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

/**
 * Resolve ${ENV_VAR} placeholders in all string fields of a config object.
 * Non-string fields are passed through unchanged.
 */
function resolveEnvVars(raw: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    resolved[key] = typeof value === "string" ? resolveEnvVar(value) : value;
  }
  return resolved;
}

// ============================================================================
// Config Parser
// ============================================================================

/**
 * Parse and validate raw plugin config from openclaw.json.
 *
 * Resolves ${ENV_VAR} placeholders in string fields, then validates
 * the full config against the Zod schema. Throws with clear field-level
 * error messages on invalid config.
 *
 * @param raw - Raw config object from `api.pluginConfig`
 * @returns Validated config with all defaults applied
 * @throws {Error} If config is missing, or any field fails validation
 */
export function parseConfig(raw: unknown): PluginConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("memory-memwal: config is required");
  }

  // Resolve env vars before validation
  const resolved = resolveEnvVars(raw as Record<string, unknown>);

  // Validate with Zod — clear error messages per field
  const result = ConfigSchema.safeParse(resolved);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`memory-memwal: invalid config:\n${issues}`);
  }

  return result.data;
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
