/**
 * TYPES — Single Source of Truth
 *
 * Structure: §1 Helpers → §2 Enums → §3 DB Types → §4 Common Primitives
 *
 * Naming:
 *   User, UserInsert          — Raw DB types (match table name)
 *   AUTH_METHODS / AuthMethod — Enum values (SCREAMING_SNAKE) / types (PascalCase)
 *
 * Feature-Specific Schemas:
 *   - Form schemas → feature/[name]/api/form.ts
 *   - API input schemas → feature/[name]/api/input.ts
 *   - Only common primitives and cross-cutting schemas stay here
 */

import {
  // Tables
  users,
  zkLoginSessions,
  walletSessions,
  notes,
  noteMemoryHighlights,
  // Enums
  authMethod,
  memoryStatus,
  // Types
  type ZkProofData,
  type EntityRelationship,
} from "@/shared/db/schema";
import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { PgEnum, PgTable, TableConfig } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

// §1 HELPERS (internal)

function enumDef<const T extends [string, ...string[]]>(pgEnum: PgEnum<T>) {
  return pgEnum.enumValues;
}
function tableDef<T extends PgTable<TableConfig>>(table: T) {
  return {
    selectSchema: createSelectSchema(table),
    insertSchema: createInsertSchema(table),
  };
}
type Select<T extends PgTable> = InferSelectModel<T>;
type Insert<T extends PgTable> = InferInsertModel<T>;

// §2 ENUMS — SCREAMING_SNAKE (runtime array) + PascalCase (type)

export const AUTH_METHODS = enumDef(authMethod);
export const MEMORY_STATUSES = enumDef(memoryStatus);

export type AuthMethod = (typeof AUTH_METHODS)[number];
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

// Re-export types for convenience
export type { ZkProofData, EntityRelationship };

// Type aliases for backward compatibility with note feature
export type MemoryHighlightStatus = MemoryStatus;
export type GraphEntity = {
  id: string;
  label: string;
  type: string;
  confidence: number;
};
export type GraphRelationship = {
  source: string;
  target: string;
  type: string;
  confidence: number;
};

// §3 DB ROW TYPES — User/UserInsert (Select/Insert), userSchema/userInsertSchema (Zod)

const usersDef = tableDef(users);
const zkLoginSessionsDef = tableDef(zkLoginSessions);
const walletSessionsDef = tableDef(walletSessions);
const notesDef = tableDef(notes);
const noteMemoryHighlightsDef = tableDef(noteMemoryHighlights);

// ─── Select types (what you get back from a query) ───

export type User = Select<typeof users>;
export type ZkLoginSession = Select<typeof zkLoginSessions>;
export type WalletSession = Select<typeof walletSessions>;
export type Note = Select<typeof notes>;
export type NoteWithMemoryCount = Note & { memoryCount: number };
export type NoteMemoryHighlight = Select<typeof noteMemoryHighlights>;

// ─── Insert types (for creating new rows) ───

export type UserInsert = Insert<typeof users>;
export type ZkLoginSessionInsert = Insert<typeof zkLoginSessions>;
export type WalletSessionInsert = Insert<typeof walletSessions>;
export type NoteInsert = Insert<typeof notes>;
export type NoteMemoryHighlightInsert = Insert<typeof noteMemoryHighlights>;

// ─── Zod Schemas (for validation in API/forms) ───

export const userSchema = usersDef.selectSchema;
export const userInsertSchema = usersDef.insertSchema;

export const zkLoginSessionSchema = zkLoginSessionsDef.selectSchema;
export const zkLoginSessionInsertSchema = zkLoginSessionsDef.insertSchema;

export const walletSessionSchema = walletSessionsDef.selectSchema;
export const walletSessionInsertSchema = walletSessionsDef.insertSchema;

export const noteSchema = notesDef.selectSchema;
export const noteInsertSchema = notesDef.insertSchema;

export const noteMemoryHighlightSchema = noteMemoryHighlightsDef.selectSchema;
export const noteMemoryHighlightInsertSchema = noteMemoryHighlightsDef.insertSchema;

// ─── Memory data type (extracted from Lexical MemoryHighlightNodes) ───

export type MemoryCategory =
  | "note"
  | "fact"
  | "preference"
  | "todo"
  | "general";

export type MemoryData = {
  id: string;
  text: string;
  status: MemoryStatus;
  category: MemoryCategory;
  importance: number;
  embedding?: number[];
  memwalMemoryId?: string;
  memwalBlobId?: string;
  suiTxDigest?: string;
  createdAt: string;
  savedAt?: string;
  errorMessage?: string;
};

// §4 COMMON PRIMITIVES (shared input patterns)

// UUIDv7 validation for IDs
export const uuidv7Schema = z.string().uuid();

// Common ID input schema
export const idInputSchema = z.object({
  id: uuidv7Schema,
});

// Optional ID for create/update forms
export const optionalIdSchema = z.object({
  id: uuidv7Schema.optional(),
});
