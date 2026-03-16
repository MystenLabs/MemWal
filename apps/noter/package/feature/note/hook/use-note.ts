"use client";

/**
 * Note Hook
 *
 * Provides CRUD operations for a single note with auto-save functionality.
 * Debounces save operations to avoid excessive database writes.
 */

import { useMemo } from "react";
import { trpc } from "@/shared/lib/trpc/client";
import type { SerializedEditorState } from "lexical";
import { useDebouncedCallback } from "use-debounce";

export function useNote(noteId: string) {
  const utils = trpc.useUtils();

  const noteQuery = trpc.note.get.useQuery(
    { id: noteId },
    {
      enabled: !!noteId,
      staleTime: 1000 * 60, // 1 minute
    }
  );

  const updateMutation = trpc.note.update.useMutation({
    onSuccess: (updatedNote) => {
      // Invalidate the current note query
      utils.note.get.invalidate({ id: noteId });

      // Invalidate the note list to update sidebar
      utils.note.list.invalidate();
    },
  });

  // Debounced auto-save (3 seconds)
  const save = useDebouncedCallback(
    async (content: SerializedEditorState, plainText: string) => {
      await updateMutation.mutateAsync({
        id: noteId,
        content,
        plainText,
      });
    },
    3000
  );

  // Immediate save (no debounce) - use for critical updates like memory status
  const saveImmediate = async (content: SerializedEditorState, plainText: string) => {
    await updateMutation.mutateAsync({
      id: noteId,
      content,
      plainText,
    });
  };

  const note = useMemo(() => noteQuery.data, [noteQuery.data]);

  return {
    note,
    isLoading: noteQuery.isLoading,
    error: noteQuery.error,
    save,
    saveImmediate,
    isSaving: updateMutation.isPending,
  };
}
