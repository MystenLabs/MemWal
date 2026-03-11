/**
 * CHAT SERVICE LAYER
 *
 * DB operations for chat feature.
 * All service functions take db as first parameter (dependency injection pattern).
 * Called exclusively by api/route.ts handlers.
 */

import type { db as dbClient } from "@/shared/lib/db";
import { chats, messages } from "@/shared/db/schema";
import { eq, desc, and } from "drizzle-orm";
import type { AiMessagePart } from "@/shared/db/type";

type DbClient = typeof dbClient;

// ══════════════════════════════════════════════════════════════
// CHAT MANAGEMENT
// ══════════════════════════════════════════════════════════════

/**
 * List all chats for a user
 * Ordered by most recent first
 */
export async function listUserChats(db: DbClient, userId: string) {
  return db
    .select()
    .from(chats)
    .where(eq(chats.userId, userId))
    .orderBy(desc(chats.createdAt));
}

/**
 * Get single chat with its messages
 * Returns null if chat doesn't exist or user doesn't own it
 */
export async function getChatWithMessages(
  db: DbClient,
  chatId: string,
  userId: string
) {
  const [chat] = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .limit(1);

  if (!chat) return null;

  const chatMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(messages.createdAt);

  return { ...chat, messages: chatMessages };
}

/**
 * Create new chat for user
 * Title and model are optional, will use defaults if not provided
 */
export async function createChat(
  db: DbClient,
  input: {
    id?: string;
    userId: string;
    title?: string;
    model?: string;
  }
) {
  const [chat] = await db
    .insert(chats)
    .values({
      id: input.id,
      userId: input.userId,
      title: input.title,
      model: input.model,
    })
    .returning();
  return chat;
}

/**
 * Update chat title
 * Returns updated chat or null if not found or not owned by user
 */
export async function updateChatTitle(
  db: DbClient,
  chatId: string,
  userId: string,
  title: string
) {
  const [chat] = await db
    .update(chats)
    .set({ title })
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .returning();
  return chat || null;
}

/**
 * Delete chat and all its messages (cascade handled by DB)
 */
export async function deleteChat(
  db: DbClient,
  chatId: string,
  userId: string
) {
  await db
    .delete(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)));
}

// ══════════════════════════════════════════════════════════════
// MESSAGE MANAGEMENT
// ══════════════════════════════════════════════════════════════

/**
 * Save user message to chat
 * Returns created message
 */
export async function saveUserMessage(
  db: DbClient,
  input: { chatId: string; content: string }
) {
  const [message] = await db
    .insert(messages)
    .values({
      chatId: input.chatId,
      role: "user",
      content: input.content,
    })
    .returning();
  return message;
}

/**
 * Save assistant message with AI parts
 * Includes token usage and model info
 */
export async function saveAssistantMessage(
  db: DbClient,
  input: {
    chatId: string;
    parts: AiMessagePart[];
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
  }
) {
  const [message] = await db
    .insert(messages)
    .values({
      chatId: input.chatId,
      role: "assistant",
      parts: input.parts,
      model: input.model,
      status: "completed",
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
    })
    .returning();
  return message;
}
