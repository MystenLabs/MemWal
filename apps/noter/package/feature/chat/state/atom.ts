import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { Chat, Message } from "@/shared/db/type";
import { DEFAULT_MODEL } from "@/shared/lib/ai/constant";

/** All chats (for sidebar/history) */
export const chatsAtom = atom<Chat[]>([]);

/** Messages per chat (atomFamily for isolation) */
export const messagesFamily = atomFamily((chatId: string) =>
  atom<Message[]>([])
);

/** Current model selection */
export const modelAtom = atom<string>(DEFAULT_MODEL);

/** Currently active chat ID */
export const activeChatIdAtom = atom<string | null>(null);
