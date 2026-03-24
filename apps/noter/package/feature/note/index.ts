/**
 * NOTE FEATURE — Public API
 * Client-safe exports only (types, hooks, UI components)
 * Never export internal files (api/route, lib/pdw-client, etc.)
 */

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type {
  NoteListItemProps,
  NoteEditorProps,
} from "./domain/type";

// ═══════════════════════════════════════════════════════════════
// FORMS
// ═══════════════════════════════════════════════════════════════

export { noteFormSchema, type NoteFormData } from "./api/form";

// ═══════════════════════════════════════════════════════════════
// DOMAIN FUNCTIONS (client-safe)
// ═══════════════════════════════════════════════════════════════

export {
  extractPlainText,
  findTextOffset,
  generateNoteTitle,
  isNoteEmpty,
  getWordCount,
} from "./domain/note";

// ═══════════════════════════════════════════════════════════════
// UI COMPONENTS
// ═══════════════════════════════════════════════════════════════

export { NoteEditor } from "./ui/note-editor";
export { NoteList } from "./ui/note-list";

// ═══════════════════════════════════════════════════════════════
// HOOKS
// ═══════════════════════════════════════════════════════════════

export { useNote } from "./hook/use-note";
export { useNoteList } from "./hook/use-note-list";

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

export {
  selectedNoteIdAtom,
  hasUnsavedChangesAtom,
} from "./state/atom";
