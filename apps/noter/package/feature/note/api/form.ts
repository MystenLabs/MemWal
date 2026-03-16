/**
 * FORM SCHEMAS — UI form validation (looser, has optionalId)
 * Derives from shared DB insert schemas
 */

import { noteInsertSchema, optionalIdSchema } from "@/shared/db/type";
import { z } from "zod";

// ═══════════════════════════════════════════════════════════════
// NOTE FORM
// ═══════════════════════════════════════════════════════════════

export const noteFormSchema = noteInsertSchema
  .pick({
    title: true,
    content: true,
    plainText: true,
  })
  .merge(optionalIdSchema)
  .extend({
    title: z.string().min(1).max(200).optional(),
    content: z.any(), // Lexical SerializedEditorState
    plainText: z.string().min(0),
  });

export type NoteFormData = z.infer<typeof noteFormSchema>;
