/**
 * CHAT FORM SCHEMAS
 *
 * UI form validation schemas for chat feature.
 * Derived from shared/db/type.ts using .pick().extend() pattern.
 *
 * Pattern: Forms use optionalId to handle both create and update modes in a single schema.
 */

import { z } from "zod";
import { chatInsertSchema, uuidv7Schema } from "@/shared/db/type";

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

/** Optional ID helper for create/update forms */
const optionalId = { id: uuidv7Schema.optional() } as const;

// ══════════════════════════════════════════════════════════════
// FORM SCHEMAS
// ══════════════════════════════════════════════════════════════

/**
 * Chat settings form (create/edit chat)
 * Used in chat creation dialogs and settings modals
 */
export const chatFormSchema = chatInsertSchema
  .pick({ title: true, model: true, systemPrompt: true, temperature: true })
  .extend({
    ...optionalId,
    title: z
      .string()
      .min(1, "Title is required")
      .max(100, "Title is too long")
      .optional(),
    model: z.string().min(1, "Model is required"),
    systemPrompt: z.string().max(2000, "System prompt is too long").optional(),
    temperature: z
      .number()
      .min(0, "Temperature must be at least 0")
      .max(2, "Temperature must be at most 2")
      .optional(),
  });

/**
 * Message input form (user message)
 * Used in chat input component for sending messages
 */
export const messageFormSchema = z.object({
  content: z.string().min(1, "Message cannot be empty"),
});

// ══════════════════════════════════════════════════════════════
// TYPE EXPORTS
// ══════════════════════════════════════════════════════════════

export type ChatFormData = z.infer<typeof chatFormSchema>;
export type MessageFormData = z.infer<typeof messageFormSchema>;
