/**
 * NOTE API INPUT SCHEMAS
 *
 * Lexical-first architecture: All memory data lives in note.content (EditorState).
 */

import { noteInsertSchema, idInputSchema } from "@/shared/db/type";
import { z } from "zod";

// ═══════════════════════════════════════════════════════════════
// NOTE CRUD
// ═══════════════════════════════════════════════════════════════

export const createNoteInput = noteInsertSchema
  .pick({
    title: true,
    content: true,
    plainText: true,
  })
  .extend({
    title: z.string().min(1).max(200).optional(),
    content: z.any().optional(), // Lexical SerializedEditorState (JSON)
    plainText: z.string().min(0).optional(),
  });

export const updateNoteInput = noteInsertSchema
  .pick({
    title: true,
    content: true,
    plainText: true,
  })
  .merge(idInputSchema)
  .extend({
    title: z.string().min(1).max(200).optional(),
    content: z.any().optional(),
    plainText: z.string().optional(),
  });

export const getNoteInput = idInputSchema;

export const deleteNoteInput = idInputSchema;

export const listNotesInput = z.object({
  limit: z.number().min(1).max(100).optional().default(50),
  offset: z.number().min(0).optional().default(0),
});

// ═══════════════════════════════════════════════════════════════
// MEMORY DETECTION
// ═══════════════════════════════════════════════════════════════

export const detectMemoriesInput = z.object({
  noteId: z.string().uuid(),
  plainText: z.string().optional(), // Optional: use current editor content if provided
});

// ═══════════════════════════════════════════════════════════════
// TYPE EXPORTS
// ═══════════════════════════════════════════════════════════════

export type CreateNoteInput = z.infer<typeof createNoteInput>;
export type UpdateNoteInput = z.infer<typeof updateNoteInput>;
export type GetNoteInput = z.infer<typeof getNoteInput>;
export type DeleteNoteInput = z.infer<typeof deleteNoteInput>;
export type ListNotesInput = z.infer<typeof listNotesInput>;
export type DetectMemoriesInput = z.infer<typeof detectMemoriesInput>;
