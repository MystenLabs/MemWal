import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

/**
 * SCHEMA ARCHITECTURE (for AI context)
 *
 * 1. UUIDV7 IDS: All primary keys use UUIDv7 for time-sorted, globally unique identifiers.
 *    Generated via `uuidv7()` in basicFields mixin. Provides chronological ordering and
 *    distributed ID generation without coordination.
 *
 * 2. BASIC FIELDS PATTERN: All tables extend `basicFields` which provides:
 *    - id: uuid().primaryKey().$defaultFn(() => uuidv7())
 *    - createdAt: timestamp().defaultNow().notNull()
 *    This ensures consistency across the schema and simplifies table definitions.
 *
 * 3. ZKLOGIN AUTHENTICATION:
 *    - users.suiAddress: Derived from OAuth JWT + user salt via zkLogin derivation
 *    - users.authMethod: "zklogin" | "wallet" (discriminates auth type)
 *    - zkLoginSessions: Stores ephemeral keypairs, nonce, randomness, maxEpoch, zkProof
 *    - Session flow: Generate ephemeral key → OAuth redirect → Derive address → Generate proof
 *    - Sessions expire based on maxEpoch from Sui network (typically 24 hours)
 *
 * 4. WALLET AUTHENTICATION:
 *    - Alternative to zkLogin for users with existing Sui wallets (Slush, Sui Wallet, etc.)
 *    - users.walletType: "slush" | "sui-wallet" (stored when authMethod = "wallet")
 *    - walletSessions: Stores signed message, signature, wallet address for verification
 *    - Verification: Message signature checked against wallet public key
 *    - Session duration: 24 hours (independent of Sui epochs)
 *
 * 5. SESSION EXPIRATION PATTERNS:
 *    - zkLoginSessions.expiresAt: Based on maxEpoch boundary (Sui network constraint)
 *    - walletSessions.expiresAt: Fixed 24-hour duration from creation
 *    - Both checked on session validation via isSessionExpired() helper
 *    - Expired sessions are invalid for authentication but remain in DB for audit
 *
 * 6. NOTES SYSTEM (Apple Notes / Notion-like with MemWal):
 *    - notes: User-created notes with Lexical editor content
 *    - notes.content: Lexical EditorState JSON for rich text editing
 *    - notes.plainText: Extracted plain text for AI memory detection and search
 *    - noteMemoryHighlights: AI-detected memory snippets with blockchain persistence
 *      - Status workflow: preparing → pending → signing → uploading → indexing → saved
 *      - Stores highlighted text, AI-extracted metadata (title, content, entities)
 *      - MemWal blockchain metadata: blobId (Walrus), graphObjectId (Nautilus), transactionId
 *      - Knowledge graph: Entities (["person:Alice", "place:Paris"]) and relationships
 *      - Approval workflow: User approves/rejects before blockchain upload
 *
 * 9. INDEXES:
 *    - All foreign keys have indexes for join performance
 *    - Composite indexes for common query patterns (userId + createdAt)
 *    - Session tables indexed on expiresAt for cleanup queries
 *    - Message tables indexed on chatId + createdAt for chronological fetch
 */

// ════════════════════════════════════════════════════════════════
// SHARED FIELDS
// ════════════════════════════════════════════════════════════════

const basicFields = {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  createdAt: timestamp().defaultNow().notNull(),
};

// ════════════════════════════════════════════════════════════════
// USERS (zkLogin + Wallet auth)
// ════════════════════════════════════════════════════════════════

export const authMethod = pgEnum("auth_method", ["zklogin", "wallet", "enoki"]);

export const users = pgTable(
  "users",
  {
    ...basicFields,

    // Sui address (from zkLogin derivation OR wallet)
    suiAddress: text().notNull().unique(),

    // Authentication method
    authMethod: authMethod().notNull(),

    // zkLogin fields (nullable when wallet auth)
    provider: text(), // "google" | "facebook" | "twitch" | "slack"
    providerSub: text(), // OAuth subject ID

    // Wallet fields (nullable when zkLogin auth)
    walletType: text(), // "slush" | "sui-wallet"

    // Profile (optional, from OAuth or user input)
    name: text(),
    email: text(),
    avatar: text(),

    // Enoki delegate key credentials (nullable, only for Enoki auth)
    delegatePrivateKey: text(),
    delegateAccountId: text(),

    // Last active
    lastSeenAt: timestamp(),
  },
  (t) => [
    index().on(t.provider, t.providerSub),
    index().on(t.authMethod),
    index().on(t.suiAddress),
  ]
);

// ════════════════════════════════════════════════════════════════
// (REMOVED: chats table — AI chat feature was unused bloat)
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// ZKLOGIN SESSIONS (ephemeral keypairs with expiration)
// ════════════════════════════════════════════════════════════════

export type ZkProofData = {
  proof: string;
  addressSeed: string;
};

export const zkLoginSessions = pgTable(
  "zklogin_sessions",
  {
    ...basicFields,

    userId: uuid().references(() => users.id, { onDelete: "cascade" }),

    // Ephemeral keypair (store encrypted in production)
    ephemeralPrivateKey: text().notNull(),
    ephemeralPublicKey: text().notNull(),

    // Session metadata
    maxEpoch: integer().notNull(),
    randomness: text().notNull(),
    nonce: text().notNull(),

    // Proof caching (reusable within session)
    zkProof: jsonb().$type<ZkProofData>(),

    // Session expiration
    expiresAt: timestamp().notNull(),
  },
  (t) => [index().on(t.userId), index().on(t.expiresAt)]
);

// ════════════════════════════════════════════════════════════════
// WALLET SESSIONS (for wallet-based authentication)
// ════════════════════════════════════════════════════════════════

export const walletSessions = pgTable(
  "wallet_sessions",
  {
    ...basicFields,

    userId: uuid().references(() => users.id, { onDelete: "cascade" }),

    // Wallet address (should match users.suiAddress)
    walletAddress: text().notNull(),

    // Wallet type
    walletType: text().notNull(), // "slush" | "sui-wallet"

    // Signed message for verification
    signedMessage: text().notNull(),
    signature: text().notNull(),
    signedAt: timestamp().notNull(),

    // Session expiration (24 hours)
    expiresAt: timestamp().notNull(),
  },
  (t) => [index().on(t.userId), index().on(t.expiresAt), index().on(t.walletAddress)]
);

// ════════════════════════════════════════════════════════════════
// WALLET CHALLENGES (one-time nonces for replay protection)
// ════════════════════════════════════════════════════════════════

export const walletChallenges = pgTable(
  "wallet_challenges",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    createdAt: timestamp().defaultNow().notNull(),

    // Server-generated random nonce
    nonce: text().notNull(),

    // Challenge expiration (5 minutes)
    expiresAt: timestamp().notNull(),
  },
  (t) => [index().on(t.expiresAt)]
);

// ════════════════════════════════════════════════════════════════
// NOTES (Apple Notes / Notion-like)
// ════════════════════════════════════════════════════════════════

export const notes = pgTable(
  "notes",
  {
    ...basicFields,

    // Owner
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // Content
    title: text(), // Auto-generated from first line or user-set
    content: jsonb().notNull(), // Lexical EditorState JSON (contains MemoryHighlightNodes)
    plainText: text().notNull(), // Extracted plain text for search/memory extraction

    // Metadata
    updatedAt: timestamp().defaultNow().notNull(),
  },
  (t) => [
    index().on(t.userId),
    index().on(t.userId, t.updatedAt),
  ]
);

// ════════════════════════════════════════════════════════════════
// NOTE MEMORY HIGHLIGHTS (MemWal blockchain integration)
// ════════════════════════════════════════════════════════════════

export const memoryStatus = pgEnum("memory_status", [
  "preparing",    // AI is analyzing
  "pending",      // User needs to approve
  "signing",      // User signing transaction
  "uploading",    // Uploading to Walrus
  "indexing",     // Indexing in Nautilus
  "saved",        // Successfully saved to blockchain
  "rejected",     // User rejected
  "error",        // Failed to save
]);

export type EntityRelationship = {
  from: string;
  to: string;
  type: string;
};

export const noteMemoryHighlights = pgTable(
  "note_memory_highlights",
  {
    ...basicFields,

    // References
    noteId: uuid()
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),

    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    // Highlighted content
    highlightedText: text().notNull(),
    highlightedHtml: text(), // HTML with formatting

    // Text position (for editor highlighting)
    startOffset: integer(),
    endOffset: integer(),
    extractedText: text(), // Backward compat alias for highlightedText

    // AI-extracted memory data
    memoryTitle: text(),
    memoryContent: text(),
    entities: jsonb().$type<string[]>(), // ["person:Alice", "place:Paris", "event:Meeting"]
    relationships: jsonb().$type<EntityRelationship[]>(),

    // MemWal blockchain metadata
    status: memoryStatus().default("preparing").notNull(),
    blobId: text(),           // Walrus blob ID (after upload)
    graphObjectId: text(),    // Nautilus graph object ID (after indexing)
    transactionId: text(),    // Sui transaction digest

    // Timestamps
    approvedAt: timestamp(),
    savedAt: timestamp(),
    errorMessage: text(),
  },
  (t) => [
    index().on(t.noteId),
    index().on(t.userId),
    index().on(t.status),
    index().on(t.userId, t.createdAt),
  ]
);

// ════════════════════════════════════════════════════════════════
// (REMOVED: messages table — AI chat feature was unused bloat)
// ════════════════════════════════════════════════════════════════
