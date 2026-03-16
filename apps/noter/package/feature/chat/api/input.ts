/**
 * Chat API Input Schemas
 *
 * Derived from shared/db/type.ts using .pick().extend() pattern.
 * Never redefine DB fields - always derive from insertSchema.
 *
 * Pattern: [Entity][Action]Input (e.g., ChatCreateInput)
 */

import { z } from "zod";
import {
  chatInsertSchema,
  messageInsertSchema,
  uuidv7Schema,
  idInputSchema,
} from "@/shared/db/type";

// ══════════════════════════════════════════════════════════
// CHAT INPUTS
// ══════════════════════════════════════════════════════════

/** Get single chat by ID */
export const chatGetInput = idInputSchema;

/** Create new chat */
export const chatCreateInput = chatInsertSchema
  .pick({
    id: true,
    title: true,
    model: true,
  })
  .partial();

/** Update chat title */
export const chatUpdateTitleInput = z.object({
  id: uuidv7Schema,
  title: z.string(),
});

/** Delete chat by ID */
export const chatDeleteInput = idInputSchema;

// ══════════════════════════════════════════════════════════
// MESSAGE INPUTS
// ══════════════════════════════════════════════════════════

/** Save user message */
export const messageSaveUserInput = messageInsertSchema.pick({
  chatId: true,
  content: true,
});

/** Save assistant message */
export const messageSaveAssistantInput = messageInsertSchema
  .pick({
    chatId: true,
    parts: true,
    model: true,
    promptTokens: true,
    completionTokens: true,
  })
  .required({
    chatId: true,
    parts: true,
  })
  .partial({
    model: true,
    promptTokens: true,
    completionTokens: true,
  });

// ══════════════════════════════════════════════════════════
// TYPE EXPORTS
// ══════════════════════════════════════════════════════════

export type ChatGetInput = z.infer<typeof chatGetInput>;
export type ChatCreateInput = z.infer<typeof chatCreateInput>;
export type ChatUpdateTitleInput = z.infer<typeof chatUpdateTitleInput>;
export type ChatDeleteInput = z.infer<typeof chatDeleteInput>;

export type MessageSaveUserInput = z.infer<typeof messageSaveUserInput>;
export type MessageSaveAssistantInput = z.infer<typeof messageSaveAssistantInput>;
