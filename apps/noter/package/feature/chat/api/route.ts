import { router, procedure, protectedProcedure } from "@/shared/lib/trpc/init";
import { TRPCError } from "@trpc/server";
import { chats, messages } from "@/shared/db/schema";
import { eq, desc, and } from "drizzle-orm";
import {
  chatGetInput,
  chatCreateInput,
  chatUpdateTitleInput,
  chatDeleteInput,
  messageSaveUserInput,
  messageSaveAssistantInput,
} from "./input";
import * as chatService from "../domain/service";

export const chatRouter = router({
  // List user's chats only
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.query.chats.findMany({
      where: eq(chats.userId, ctx.userId),
      orderBy: [desc(chats.createdAt)],
      limit: 50,
    });
  }),

  // Get single chat with ownership verification
  get: protectedProcedure
    .input(chatGetInput)
    .query(async ({ ctx, input }) => {
      const chat = await ctx.db.query.chats.findFirst({
        where: and(eq(chats.id, input.id), eq(chats.userId, ctx.userId)),
        with: {
          messages: {
            orderBy: [messages.createdAt],
          },
        },
      });

      if (!chat) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Chat not found or access denied",
        });
      }

      return chat;
    }),

  // Create new chat with userId
  create: protectedProcedure
    .input(chatCreateInput)
    .mutation(({ ctx, input }) =>
      chatService.createChat(ctx.db, {
        id: input.id,
        userId: ctx.userId,
        title: input.title ?? undefined,
        model: input.model ?? undefined,
      })
    ),

  // Update chat title with ownership verification
  updateTitle: protectedProcedure
    .input(chatUpdateTitleInput)
    .mutation(async ({ ctx, input }) => {
      const chat = await chatService.updateChatTitle(
        ctx.db,
        input.id,
        ctx.userId,
        input.title
      );

      if (!chat) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Chat not found or access denied",
        });
      }

      return chat;
    }),

  // Delete chat with ownership verification
  delete: protectedProcedure
    .input(chatDeleteInput)
    .mutation(async ({ ctx, input }) => {
      await chatService.deleteChat(ctx.db, input.id, ctx.userId);
      return { success: true };
    }),

  // Save user message
  saveUserMessage: protectedProcedure
    .input(messageSaveUserInput)
    .mutation(({ ctx, input }) =>
      chatService.saveUserMessage(ctx.db, {
        chatId: input.chatId,
        content: input.content ?? "",
      })
    ),

  // Save assistant message
  saveAssistantMessage: protectedProcedure
    .input(messageSaveAssistantInput)
    .mutation(({ ctx, input }) =>
      chatService.saveAssistantMessage(ctx.db, {
        chatId: input.chatId,
        parts: input.parts ?? [],
        model: input.model ?? undefined,
        promptTokens: input.promptTokens ?? undefined,
        completionTokens: input.completionTokens ?? undefined,
      })
    ),
});
