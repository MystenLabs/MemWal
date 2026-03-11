"use client";

/**
 * Note List Hook
 *
 * Provides list management operations for notes.
 * Handles create, delete, and list operations.
 */

import { trpc } from "@/shared/lib/trpc/client";

export function useNoteList() {
  const utils = trpc.useUtils();
  const listQuery = trpc.note.list.useQuery({});
  const createMutation = trpc.note.create.useMutation({
    onSuccess: () => {
      utils.note.list.invalidate();
    },
  });
  const deleteMutation = trpc.note.delete.useMutation({
    onSuccess: () => {
      utils.note.list.invalidate();
    },
  });

  return {
    notes: listQuery.data || [],
    isLoading: listQuery.isLoading,
    error: listQuery.error,
    createNote: createMutation.mutateAsync,
    deleteNote: deleteMutation.mutateAsync,
    isCreating: createMutation.isPending,
    isDeleting: deleteMutation.isPending,
  };
}
