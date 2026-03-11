"use client";

import { MarketingBorder } from "@/package/shared/components/border";
import { motion } from "framer-motion";
import Image from "next/image";
import { useState } from "react";
import { useChat } from "../hook/use-chat";
import { ChatInput } from "./chat-input";
import { MessageList } from "./message-list";
type ChatContainerProps = {
  chatId: string;
};

export function ChatContainer({ chatId }: ChatContainerProps) {
  const [input, setInput] = useState("");
  const { messages, sendMessage, status } = useChat({ chatId });

  const isLoading = status === "streaming" || status === "submitted";

  const onSubmit = () => {
    if (input.trim() && !isLoading) {
      sendMessage({ role: "user", parts: [{ type: "text", text: input }] });
      setInput("");
    }
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background">
      <MarketingBorder />
      <motion.div
        initial={{ translateY: -1000, opacity: 0 }}
        animate={{ translateY: 0, opacity: 1 }}
        transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] }}
        className="fixed inset-0 z-0"
      >
        <Image src="/bgr-3.webp" alt="Noter" fill className="object-cover invert dark:invert-0 -translate-y-[80vh] background" />
      </motion.div>

      <motion.div
        className="fixed inset-0 z-0"
        initial={{ opacity: 0 }}
        animate={{ opacity: messages.length === 0 ? 1 : 0 }}
        transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
      >
        <Image src="/bgr-1.webp" alt="Noter" fill className="object-cover invert dark:invert-0 background" />
      </motion.div>

      <div className="z-10 flex min-h-0 flex-1 flex-col overflow-hidden pt-8">
        <div className="layout-scroll no-scrollbar py-6">
          <MessageList messages={messages as any} isLoading={isLoading} />
        </div>
        <div className="shrink-0">
          <ChatInput
            input={input}
            setInput={setInput}
            onSubmit={onSubmit}
            isLoading={isLoading}
          />
        </div>
      </div>
    </div>
  );
}
