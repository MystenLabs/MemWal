"use client";

import { useChat as useAiChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useCallback } from "react";
import { modelAtom } from "../state/atom";
import { trpc } from "@/shared/lib/trpc/client";
import { sessionAtom } from "@/feature/auth"; // ✓ Import from barrel, not internal file

export type UseChatOptions = {
  chatId: string;
};

export function useChat({ chatId }: UseChatOptions) {
  const model = useAtomValue(modelAtom);
  const session = useAtomValue(sessionAtom);
  const utils = trpc.useUtils();
  const chatCreatedRef = useRef(false);
  const messagesLoadedRef = useRef(false);


  // Fetch existing chat with messages
  const { data: existingChat } = trpc.chat.get.useQuery(
    { id: chatId },
    { enabled: !!chatId }
  );

  // Mutations for persistence
  const createChat = trpc.chat.create.useMutation();
  const saveUserMessage = trpc.chat.saveUserMessage.useMutation();
  const saveAssistantMessage = trpc.chat.saveAssistantMessage.useMutation();
  const updateTitle = trpc.chat.updateTitle.useMutation();

  // Ensure chat exists
  const ensureChatExists = useCallback(async () => {
    if (chatCreatedRef.current) return;
    chatCreatedRef.current = true;

    try {
      await createChat.mutateAsync({ id: chatId });
      utils.chat.list.invalidate();
    } catch {
      // Chat already exists, ignore
    }
  }, [chatId, createChat, utils.chat.list]);

  const chat = useAiChat({
    id: chatId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ai / @ai-sdk/react version mismatch
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: { model },
      headers: (): Record<string, string> => {
        if (session?.sessionId) {
          return { "x-session-id": session.sessionId };
        }
        return {};
      },
    }) as any,
    onFinish: async ({ messages: allMessages }) => {
      // Get the last assistant message
      const lastMessage = allMessages.findLast((m) => m.role === "assistant");
      if (!lastMessage?.parts) return;

      // Save assistant message to DB
      await saveAssistantMessage.mutateAsync({
        chatId,
        parts: lastMessage.parts as any,
        model,
      });

      // Auto-generate title from first user message if not set
      const firstUserMessage = allMessages.find((m) => m.role === "user");
      if (firstUserMessage && allMessages.length <= 2) {
        const text =
          firstUserMessage.parts.find((p) => p.type === "text")?.text ?? "";
        if (text) {
          const title = text.slice(0, 50) + (text.length > 50 ? "..." : "");
          await updateTitle.mutateAsync({ id: chatId, title });
          utils.chat.list.invalidate();
        }
      }
    },
  });

  // Load existing messages from DB on mount
  useEffect(() => {
    if (!existingChat?.messages || messagesLoadedRef.current) return;
    if (chat.messages.length > 0) return; // Don't override if already has messages

    messagesLoadedRef.current = true;

    // Convert DB messages to UIMessage format
    const uiMessages: UIMessage[] = existingChat.messages.map((msg) => ({
      id: msg.id,
      role: msg.role as "user" | "assistant",
      parts:
        msg.role === "user"
          ? [{ type: "text" as const, text: msg.content ?? "" }]
          : (msg.parts as UIMessage["parts"]) ?? [],
      createdAt: msg.createdAt,
    }));

    if (uiMessages.length > 0) {
      chat.setMessages(uiMessages);
    }
  }, [existingChat, chat]);

  // Custom send that persists user message
  const sendMessageWithPersistence = useCallback(
    async (message: Parameters<typeof chat.sendMessage>[0]) => {
      if (!message) return;

      await ensureChatExists();

      // Extract text from parts
      const textPart = message.parts?.find((p) => p.type === "text");
      if (textPart && "text" in textPart) {
        await saveUserMessage.mutateAsync({
          chatId,
          content: textPart.text,
        });
      }

      chat.sendMessage(message);
    },
    [chat, chatId, ensureChatExists, saveUserMessage]
  );

  return {
    ...chat,
    sendMessage: sendMessageWithPersistence,
    model,
  };
}
