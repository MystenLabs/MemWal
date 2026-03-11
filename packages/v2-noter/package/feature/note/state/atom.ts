import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

// Selected note ID (persisted to localStorage)
export const selectedNoteIdAtom = atomWithStorage<string | null>(
  "selectedNoteId",
  null
);

// Active highlight ID for modal
export const activeHighlightAtom = atom<string | null>(null);

// Unsaved changes indicator
export const hasUnsavedChangesAtom = atom(false);
