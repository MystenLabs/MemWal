/**
 * DOMAIN TYPES — UI types and props (pure TS, no Zod)
 */

import type {
  NoteWithMemoryCount,
  MemoryHighlightStatus,
  GraphEntity,
  GraphRelationship,
} from "@/shared/db/type";
import type { SerializedEditorState } from "lexical";

// ═══════════════════════════════════════════════════════════════
// NOTE TYPES
// ═══════════════════════════════════════════════════════════════

export type NoteListItemProps = {
  note: Pick<NoteWithMemoryCount, "id" | "title" | "updatedAt" | "memoryCount">;
  isActive?: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
};

export type NoteEditorProps = {
  noteId?: string;
  initialContent?: SerializedEditorState;
  onSave?: (content: SerializedEditorState, plainText: string) => void;
  onChange?: (content: SerializedEditorState, plainText: string) => void;
};

// ═══════════════════════════════════════════════════════════════
// MEMORY HIGHLIGHT TYPES
// ═══════════════════════════════════════════════════════════════

export type MemoryStatusBadgeProps = {
  status: MemoryHighlightStatus;
  size?: "sm" | "md" | "lg";
};

export type MemoryDetectButtonProps = {
  noteId: string;
  disabled?: boolean;
  onDetectStart?: () => void;
  onDetectComplete?: (count: number) => void;
  onDetectError?: (error: Error) => void;
};

// ═══════════════════════════════════════════════════════════════
// MEMORY SAVE STATUS (matches memwal pattern)
// ═══════════════════════════════════════════════════════════════

export type MemorySaveStage =
  | "idle"
  | "preparing"
  | "uploading"
  | "signing"
  | "indexing"
  | "done"
  | "error";

export type MemorySaveStatus = {
  stage: MemorySaveStage;
  message: string;
  error?: Error;
};

export type MemorySaveResult = {
  id: string; // MemWal memory ID
  blobId: string; // Walrus blob ID
  transactionDigest?: string; // Sui transaction
};

// ═══════════════════════════════════════════════════════════════
// MEMORY DETECTION RESULT
// ═══════════════════════════════════════════════════════════════

export type DetectedMemory = {
  id: string;
  extractedText: string;
  startOffset: number;
  endOffset: number;
  embedding: number[];
  category: string;
  importance: number;
  graphEntities: GraphEntity[];
  graphRelationships: GraphRelationship[];
  status: MemoryHighlightStatus;
};

export type DetectMemoriesResult = {
  highlights: DetectedMemory[];
  count: number;
};
