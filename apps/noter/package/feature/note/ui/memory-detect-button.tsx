"use client";

/**
 * Memory Detect Button Component
 *
 * Triggers AI-powered memory detection on a note.
 * Shows loading state and provides visual feedback.
 */

import { useNoteMemoryDetect } from "../hook/use-note-memory-detect";
import { Button } from "@/shared/components/ui/button";
import { Sparkles, Loader2 } from "lucide-react";

export interface MemoryDetectButtonProps {
  noteId: string;
  disabled?: boolean;
}

export function MemoryDetectButton({
  noteId,
  disabled,
}: MemoryDetectButtonProps) {
  const { detectMemories, isDetecting } = useNoteMemoryDetect(noteId);

  return (
    <Button
      onClick={() => detectMemories()}
      disabled={disabled || isDetecting}
      variant="secondary"
      size="sm"
    >
      {isDetecting ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
          Detecting...
        </>
      ) : (
        <>
          <Sparkles className="h-4 w-4 mr-2" />
          Detect Memories
        </>
      )}
    </Button>
  );
}
