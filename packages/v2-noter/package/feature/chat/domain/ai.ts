/**
 * AI Chat Domain Helpers
 *
 * Pure utility functions for AI message processing.
 * Uses AI SDK v6 types directly - no DB, no async.
 *
 * @see https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message
 */

import { isToolUIPart, type ToolUIPart } from "ai";
import type { AiMessagePart } from "@/shared/db/type";

// ══════════════════════════════════════════════════════════
// AI SDK RE-EXPORTS
// ══════════════════════════════════════════════════════════

export { isToolUIPart };

// ══════════════════════════════════════════════════════════
// Text Extraction
// ══════════════════════════════════════════════════════════

export function extractTextFromParts(parts: AiMessagePart[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => ("text" in p ? p.text : ""))
    .join("\n");
}

// ══════════════════════════════════════════════════════════
// Tool Extraction
// ══════════════════════════════════════════════════════════

/**
 * Extract tool invocations from message parts.
 * Uses AI SDK's isToolUIPart for type narrowing.
 */
export function extractToolParts(parts: AiMessagePart[] | null | undefined) {
  if (!parts) return [];
  return parts.filter(isToolUIPart);
}

// ══════════════════════════════════════════════════════════
// State Utilities
// ══════════════════════════════════════════════════════════

export function getToolStateIcon(state: ToolUIPart["state"]): string {
  switch (state) {
    case "input-streaming":
    case "input-available":
      return "⏳";
    case "output-available":
      return "✓";
    case "output-error":
      return "✗";
    default:
      return "•";
  }
}

export function getToolStateLabel(state: ToolUIPart["state"]): string {
  switch (state) {
    case "input-streaming":
      return "Receiving...";
    case "input-available":
      return "Executing...";
    case "output-available":
      return "Completed";
    case "output-error":
      return "Failed";
    default:
      return "Unknown";
  }
}
