/**
 * DRIZZLE RELATIONS
 *
 * Defines all table relationships for Drizzle ORM query builder.
 * Relations enable type-safe joins and eager loading.
 */

import { relations } from "drizzle-orm";
import {
  users,
  zkLoginSessions,
  walletSessions,
} from "./schema";

// ════════════════════════════════════════════════════════════════
// USER RELATIONS
// ════════════════════════════════════════════════════════════════

export const usersRelations = relations(users, ({ many }) => ({
  zkLoginSessions: many(zkLoginSessions),
  walletSessions: many(walletSessions),
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
