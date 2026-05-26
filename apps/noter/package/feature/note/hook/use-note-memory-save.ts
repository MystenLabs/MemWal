"use client";

/**
 * Memory Save Hook (v2 SDK)
 *
 * Simplified workflow — saves a memory highlight via server-side tRPC call.
 * No wallet signing needed: Walrus Memory server handles everything.
 *
 * Stages (UI feedback):
 * 1. saving → Calling server API
 * 2. saved → Complete
 */

import { useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getMemoryById, UPDATE_MEMORY_STATUS_COMMAND } from "../plugins/MemoryHighlightPlugin";
import { STORAGE_KEYS } from "@/feature/auth/constant";
import type { SessionData } from "@/feature/auth/domain/type";

function getSessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEYS.sessionId);
    if (!raw) return null;
    return (JSON.parse(raw) as SessionData | null)?.sessionId ?? null;
  } catch {
    return null;
  }
}

export function useNoteMemorySave() {
  const [editor] = useLexicalComposerContext();
  const [isSaving, setIsSaving] = useState(false);
  const [currentMemoryId, setCurrentMemoryId] = useState<string | null>(null);

  const saveMemory = async (memoryId: string) => {
    setIsSaving(true);
    setCurrentMemoryId(memoryId);

    try {
      // Get memory data from editor
      let memoryText: string | null = null;
      editor.getEditorState().read(() => {
        const memoryNode = $getMemoryById(memoryId);
        if (!memoryNode) {
          throw new Error("Memory not found in editor");
        }
        const data = memoryNode.getMemoryData();
        memoryText = data?.text ?? null;
      });

      if (!memoryText) {
        throw new Error("Failed to get memory text");
      }

      // Stage 1: Saving (via server API)
      editor.dispatchCommand(UPDATE_MEMORY_STATUS_COMMAND, {
        memoryId,
        status: "uploading",
      });

      const sessionId = getSessionId();
      const response = await fetch("/api/memory/remember-one", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(sessionId ? { "x-session-id": sessionId } : {}),
        },
        body: JSON.stringify({ text: memoryText }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Failed to save memory: ${errText}`);
      }

      const result = await response.json();

      // Stage 2: Success
      editor.dispatchCommand(UPDATE_MEMORY_STATUS_COMMAND, {
        memoryId,
        status: "saved",
        meta: {
          memwalMemoryId: result.id,
          memwalBlobId: result.blob_id,
        },
      });

      return result;
    } catch (error) {
      console.error("[saveMemory] Error:", error);

      let errorMessage = "Unknown error";
      if (error instanceof Error) {
        errorMessage = error.message;
      }

      editor.dispatchCommand(UPDATE_MEMORY_STATUS_COMMAND, {
        memoryId,
        status: "error",
        meta: { errorMessage },
      });

      throw new Error(errorMessage);
    } finally {
      setIsSaving(false);
      setCurrentMemoryId(null);
    }
  };

  return {
    saveMemory,
    isSaving,
    currentMemoryId,
  };
}
