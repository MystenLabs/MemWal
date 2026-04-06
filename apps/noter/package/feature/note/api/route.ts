/**
 * NOTE ROUTER — tRPC routes for note operations
 *
 * Lexical-first architecture: All memory data lives in note.content (EditorState).
 * No separate noteMemoryHighlights table.
 */

import { router, protectedProcedure } from "@/shared/lib/trpc/init";
import { TRPCError } from "@trpc/server";
import { eq, desc, and } from "drizzle-orm";
import { notes } from "@/shared/db/schema";
import {
  createNoteInput,
  updateNoteInput,
  getNoteInput,
  deleteNoteInput,
  listNotesInput,
  detectMemoriesInput,
} from "./input";
import { detectMemoriesForLexical } from "../lib/memory-detector";
import { generateNoteTitle } from "../domain/note";

export const noteRouter = router({
  // ═══════════════════════════════════════════════════════════════
  // NOTE CRUD
  // ═══════════════════════════════════════════════════════════════

  /**
   * Create a new note
   */
  create: protectedProcedure
    .input(createNoteInput)
    .mutation(async ({ ctx, input }) => {
      const [note] = await ctx.db
        .insert(notes)
        .values({
          userId: ctx.userId,
          title: input.title || "Untitled Note",
          content: input.content || {
            root: {
              children: [
                {
                  children: [],
                  direction: null,
                  format: "",
                  indent: 0,
                  type: "paragraph",
                  version: 1,
                },
              ],
              direction: null,
              format: "",
              indent: 0,
              type: "root",
              version: 1,
            },
          },
          plainText: input.plainText || "",
        })
        .returning();

      return note;
    }),

  /**
   * Get a single note by ID
   */
  get: protectedProcedure.input(getNoteInput).query(async ({ ctx, input }) => {
    const note = await ctx.db.query.notes.findFirst({
      where: and(eq(notes.id, input.id), eq(notes.userId, ctx.userId)),
    });

    if (!note) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Note not found" });
    }

    return note;
  }),

  /**
   * List all notes for current user
   */
  list: protectedProcedure
    .input(listNotesInput)
    .query(async ({ ctx, input }) => {
      const limit = input.limit ?? 50;
      const offset = input.offset ?? 0;

      return ctx.db.query.notes.findMany({
        where: eq(notes.userId, ctx.userId),
        orderBy: desc(notes.updatedAt),
        limit,
        offset,
      });
    }),

  /**
   * Update note content and metadata
   */
  update: protectedProcedure
    .input(updateNoteInput)
    .mutation(async ({ ctx, input }) => {
      // Check ownership
      const existing = await ctx.db.query.notes.findFirst({
        where: eq(notes.id, input.id),
      });

      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Note not found" });
      }

      if (existing.userId !== ctx.userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Not your note" });
      }

      // Only set title if explicitly provided (rename).
      // Auto-save (content+plainText only) should NOT overwrite user-set title.
      const title = input.title ?? existing.title;

      const [updated] = await ctx.db
        .update(notes)
        .set({
          title,
          content: input.content ?? existing.content,
          plainText: input.plainText ?? existing.plainText,
          updatedAt: new Date(),
        })
        .where(eq(notes.id, input.id))
        .returning();

      return updated;
    }),

  /**
   * Delete a note
   */
  delete: protectedProcedure
    .input(deleteNoteInput)
    .mutation(async ({ ctx, input }) => {
      // Check ownership
      const note = await ctx.db.query.notes.findFirst({
        where: eq(notes.id, input.id),
      });

      if (!note) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Note not found" });
      }

      if (note.userId !== ctx.userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Not your note" });
      }

      await ctx.db.delete(notes).where(eq(notes.id, input.id));

      return { success: true };
    }),

  // ═══════════════════════════════════════════════════════════════
  // MEMORY DETECTION (AI)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Detect memories in note text using AI
   * Returns memory data for client to inject as Lexical nodes
   */
  detectMemories: protectedProcedure
    .input(detectMemoriesInput)
    .mutation(async ({ ctx, input }) => {
      // Verify note ownership
      const note = await ctx.db.query.notes.findFirst({
        where: eq(notes.id, input.noteId),
      });

      if (!note) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Note not found" });
      }

      if (note.userId !== ctx.userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Not your note" });
      }

      // Use provided plainText (current editor content) or fall back to database
      const plainText = input.plainText ?? note.plainText;

      // Extract memories using AI
      const memories = await detectMemoriesForLexical(ctx.userId, plainText, ctx.memwalKey, ctx.memwalAccountId);

      // Return memory data (client will inject as Lexical nodes)
      return {
        noteId: input.noteId,
        memories,
        count: memories.length,
      };
    }),
});
