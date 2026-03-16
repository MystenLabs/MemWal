/**
 * Chat Feature Domain Types
 *
 * UI-specific types for chat components.
 * Pure TypeScript - no Zod, no runtime validation.
 *
 * For DB types, import from @/shared/db/type
 */

import type { UIMessage } from "ai";
import type { Chat, Message } from "@/shared/db/type";

// ══════════════════════════════════════════════════════════
// COMPOSED TYPES
// ══════════════════════════════════════════════════════════

/**
 * Chat with its messages loaded
 */
export type ChatWithMessages = Chat & {
  messages: Message[];
};

/**
 * Chat message with timestamp for UI display
 * Extends AI SDK's UIMessage with optional createdAt field
 */
export type ChatMessageWithTimestamp = UIMessage & {
  createdAt?: Date | string;
};
