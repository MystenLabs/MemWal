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
import {
  authorizeMemoryRequest,
  MemoryRequestError,
} from "./memory-request";
import { memoryTextWithinLimit } from "./memory-policy";

function memoryRequestTrpcError(error: unknown): never {
  if (!(error instanceof MemoryRequestError)) throw error;
  const code = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    413: "PAYLOAD_TOO_LARGE",
    429: "TOO_MANY_REQUESTS",
    503: "SERVICE_UNAVAILABLE",
  }[error.status] as
    | "BAD_REQUEST"
    | "UNAUTHORIZED"
    | "PAYLOAD_TOO_LARGE"
    | "TOO_MANY_REQUESTS"
    | "SERVICE_UNAVAILABLE";
  throw new TRPCError({ code, message: error.message });
}

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

      // Title priority: explicit input > auto-generated from content > existing
      let title = existing.title;
      if (input.title) {
        // User explicitly renamed
        title = input.title;
      } else if (input.plainText && (existing.title === "Untitled Note" || existing.title === "New Note")) {
        // Auto-generate from first line of content (only if still default title)
        const firstLine = input.plainText.split("\n").find((l) => l.trim())?.trim();
        if (firstLine) {
          title = firstLine.length > 60 ? firstLine.slice(0, 60) + "..." : firstLine;
        }
      }

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
      // Revalidate the active session and consume the same Redis-backed write
      // budget as the REST memory routes before any note or outbound work.
      let credentials: { key: string; accountId: string };
      try {
        credentials = await authorizeMemoryRequest(ctx.request);
      } catch (error) {
        memoryRequestTrpcError(error);
      }

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
      if (!memoryTextWithinLimit(plainText)) {
        throw new TRPCError({
          code: "PAYLOAD_TOO_LARGE",
          message: "Memory text is too large",
        });
      }

      // analyze() persists extracted facts, so it must use only the credentials
      // returned by the session-bound memory-write authorization above.
      const memories = await detectMemoriesForLexical(
        ctx.userId,
        plainText,
        credentials.key,
        credentials.accountId
      );

      // Return memory data (client will inject as Lexical nodes)
      return {
        noteId: input.noteId,
        memories,
        count: memories.length,
      };
    }),
});
