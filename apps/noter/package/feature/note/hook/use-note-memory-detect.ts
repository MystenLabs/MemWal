"use client";

/**
 * Memory Detection Hook
 *
 * Triggers AI-powered memory detection on a note.
 * Injects detected memories into the editor as MemoryHighlightNodes.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getRoot } from "lexical";
import { trpc } from "@/shared/lib/trpc/client";
import { INJECT_MEMORY_HIGHLIGHTS_COMMAND } from "../plugins/MemoryHighlightPlugin";
import { toast } from "sonner";

export function useNoteMemoryDetect(noteId: string) {
  const [editor] = useLexicalComposerContext();
  const detectMutation = trpc.note.detectMemories.useMutation({
    onSuccess: (data) => {
      if (data.memories.length === 0) {
        toast.info("No memories detected in this note");
        return;
      }

      // Inject memories into editor as MemoryHighlightNodes
      editor.dispatchCommand(INJECT_MEMORY_HIGHLIGHTS_COMMAND, data.memories);

      toast.success(`Found ${data.count} ${data.count === 1 ? "memory" : "memories"}`);
    },
    onError: (error) => {
      toast.error(`Detection failed: ${error.message}`);
    },
  });

  const detectMemories = () => {
    // Get current editor content (not stale database content)
    let plainText = "";
    editor.getEditorState().read(() => {
      const root = $getRoot();
      plainText = root.getTextContent();
    });

    return detectMutation.mutateAsync({ noteId, plainText });
  };

  return {
    detectMemories,
    isDetecting: detectMutation.isPending,
    error: detectMutation.error,
  };
}
