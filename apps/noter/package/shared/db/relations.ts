/**
 * DRIZZLE RELATIONS
 *
 * Defines all table relationships for Drizzle ORM query builder.
 * Relations enable type-safe joins and eager loading.
 *
 * Pattern:
 * - one(): Many-to-one relation (FK side) - requires fields + references
 * - many(): One-to-many relation (parent side) - just table name
 *
 * See: https://orm.drizzle.team/docs/rqb#relations
 */

import { relations } from "drizzle-orm";
import {
  users,
  chats,
  messages,
  zkLoginSessions,
  walletSessions,
} from "./schema";

// ════════════════════════════════════════════════════════════════
// USER RELATIONS
// ════════════════════════════════════════════════════════════════

export const usersRelations = relations(users, ({ many }) => ({
  chats: many(chats),
  zkLoginSessions: many(zkLoginSessions),
  walletSessions: many(walletSessions),
}));

// ════════════════════════════════════════════════════════════════
// CHAT RELATIONS
// ════════════════════════════════════════════════════════════════

export const chatsRelations = relations(chats, ({ one, many }) => ({
  owner: one(users, {
    fields: [chats.userId],
    references: [users.id],
  }),
  messages: many(messages),
}));

// ════════════════════════════════════════════════════════════════
// MESSAGE RELATIONS
// ════════════════════════════════════════════════════════════════

export const messagesRelations = relations(messages, ({ one }) => ({
  chat: one(chats, {
    fields: [messages.chatId],
    references: [chats.id],
  }),
}));

// ════════════════════════════════════════════════════════════════
// ZKLOGIN SESSION RELATIONS
// ════════════════════════════════════════════════════════════════

export const zkLoginSessionsRelations = relations(zkLoginSessions, ({ one }) => ({
  user: one(users, {
    fields: [zkLoginSessions.userId],
    references: [users.id],
  }),
}));

// ════════════════════════════════════════════════════════════════
// WALLET SESSION RELATIONS
// ════════════════════════════════════════════════════════════════

export const walletSessionsRelations = relations(walletSessions, ({ one }) => ({
  user: one(users, {
    fields: [walletSessions.userId],
    references: [users.id],
  }),
}));
